// SPDX-License-Identifier: AGPL-3.0-or-later
// Port of liebharc/homr @ 7d97c3cee4ad772b50266fdf9dc78bbf9064701e (AGPL-3.0):
//   homr/staff_parsing.py    prepare_staff_image, _calculate_region, _dewarp_staff,
//                            remove_black_contours_at_edges_of_image
//   homr/staff_dewarping.py  dewarp_staff_image, calculate_span_and_optimal_points,
//                            calculate_dewarp_transformation, PiecewiseAffineTransform,
//                            DelaunayTriangulation, StaffDewarping
//   homr/image_utils.py      crop_image_and_return_new_top (_limit_x / _limit_y)
//   homr/staff_regions.py    StaffRegions.get_start_of_closest_staff_above / _below
//   homr/model.py            Staff / StaffPoint fields these read (min/max, average_unit_size, get_at,
//                            transform_coordinates), with numpy's pairwise mean / median
// OpenCV calls are the bit-exact ports in OpenCVGeometry.swift (+ StaffPreprocessing.resizeLinear).
import Foundation

/// The staff geometry homr's `prepare_staff_image` consumes (page pixel coordinates), mirroring
/// `homr.model.Staff` (its `grid` of `StaffPoint`s) and `homr.staff_regions.StaffRegions`.
/// Until SegNet + staff detection are ported this is explicit input (e.g. the oracle's `geometry.json`).
public struct StaffGeometry: Codable, Sendable, Equatable {
    /// `StaffPoint`: one x sample along the staff with the y of each staff line (5, 10, ... lines).
    public struct Point: Codable, Sendable, Equatable {
        public var x: Double
        public var y: [Double]
        /// Not used by `prepare_staff_image`; kept so the struct round-trips homr's grid.
        public var angle: Double?
        public init(x: Double, y: [Double], angle: Double? = nil) {
            self.x = x; self.y = y; self.angle = angle
        }
    }

    /// `Staff.grid`, ordered by x (homr: `min_x = grid[0].x`, `max_x = grid[-1].x`).
    public var grid: [Point]
    /// `StaffRegions.centers`: `(min_y, max_y)` of every staff on the page (this one included), as `[min, max]`.
    public var regions: [[Double]]

    public init(grid: [Point], regions: [[Double]]) {
        self.grid = grid; self.regions = regions
    }
}

/// homr `staff_parsing.prepare_staff_image` up to (not including) `center_image_on_canvas`.
public enum StaffPrepare {
    public enum Error: Swift.Error, Equatable, CustomStringConvertible {
        case badImage(width: Int, height: Int, pixelCount: Int)
        case badGeometry(String)

        public var description: String {
            switch self {
            case .badImage(let w, let h, let n): return "StaffPrepare: \(n) pixels for \(w)x\(h)"
            case .badGeometry(let m): return "StaffPrepare: bad staff geometry: \(m)"
            }
        }
    }

    /// Output of `prepareStaffImage`: the dewarped, cropped grayscale staff and the size homr resizes it to
    /// on the canvas (`image_dimensions`, computed from the region, not from the crop).
    public struct Result: Sendable {
        public var pixels: [UInt8]
        public var width: Int
        public var height: Int
        public var canvasWidth: Int
        public var canvasHeight: Int
        /// homr `to_page`: canvas point -> page point (dda4d2f point mapping).
        public var toPage: StaffToPageMapping
    }

    /// `prepare_staff_image(debug, index, staff, staff_image, regions)` for an 8-bit grayscale page:
    /// region (unit-size padding, clipped by neighbour staffs) → cv2.resize so the region height becomes
    /// the canvas height → crop (±10 / ±50 px) → piecewise-affine dewarp from the staff grid → crop to the
    /// region → `remove_black_contours_at_edges_of_image`. Returns the pre-canvas image.
    public static func prepareStaffImage(page: [UInt8], width: Int, height: Int, geometry: StaffGeometry) throws -> Result {
        guard width > 0, height > 0, page.count == width * height else {
            throw Error.badImage(width: width, height: height, pixelCount: page.count)
        }
        let staff = try HomrStaff(geometry.grid.map { HomrStaffPoint(x: $0.x, y: $0.y) })
        for r in geometry.regions where r.count != 2 { throw Error.badGeometry("region \(r) is not [min_y, max_y]") }
        let regions = geometry.regions.map { ($0[0], $0[1]) }

        // _calculate_region
        let region = calculateRegion(staff, regions)
        let rw = region[2] - region[0], rh = region[3] - region[1]
        guard rw > 0, rh > 0 else { throw Error.badGeometry("empty region \(region)") }
        let dims = StaffPreprocessing.canvasSize(width: rw, height: rh)
        let scaling = Double(dims.height) / Double(rh)
        let sw = Double(width) * scaling, sh = Double(height) * scaling
        guard sw.isFinite, sh.isFinite, sw >= 1, sh >= 1, sw < 1e7, sh < 1e7 else {
            throw Error.badGeometry("scale factor \(scaling)")
        }
        let scaledW = Int(sw), scaledH = Int(sh)
        let regionS = region.map { (Double($0) * scaling).rounded(.toNearestOrEven) }
        let step1 = [regionS[0] - 10, regionS[1] - 50, regionS[2] + 10, regionS[3] + 50]
        // crop_image_and_return_new_top on the resized page; only that window is resized (each output
        // pixel of cv2's INTER_LINEAR depends only on its own source taps, so the values are identical).
        let c1 = cropBounds(width: scaledW, height: scaledH, step1)
        let crop1 = try StaffPreprocessing.resizeLinearWindow(
            grayscale: page, width: width, height: height, toWidth: scaledW, toHeight: scaledH,
            x0: c1.x0, y0: c1.y0, x1: c1.x1, y1: c1.y1)
        let cw = c1.x1 - c1.x0, ch = c1.y1 - c1.y0
        let step2 = [regionS[0] - Double(c1.x0), regionS[1] - Double(c1.y0),
                     regionS[2] - Double(c1.x0), regionS[3] - Double(c1.y0)]
        let topLeft = (Double(c1.x0) / scaling, Double(c1.y0) / scaling)
        // _dewarp_staff(staff, None, top_left, scaling_factor)
        let local = try staff.transformed { x, y in ((x - topLeft.0) * scaling, (y - topLeft.1) * scaling) }

        var img = crop1
        var dewarp: PiecewiseAffine?
        if cw > 0, ch > 0, let tform = dewarpTransform(width: cw, height: ch, staff: local) {
            img = tform.warp(img, width: cw, height: ch, fill: 1)
            dewarp = tform
        }
        let c2 = cropBounds(width: cw, height: ch, step2)
        let ow = c2.x1 - c2.x0, oh = c2.y1 - c2.y0
        var out = [UInt8](repeating: 0, count: max(0, ow) * max(0, oh))
        if ow > 0 && oh > 0 {
            for y in 0..<oh {
                for x in 0..<ow { out[y * ow + x] = img[(c2.y0 + y) * cw + c2.x0 + x] }
            }
            removeBlackContoursAtEdges(&out, width: ow, height: oh, unitSize: local.averageUnitSize)
        }
        let toPage = StaffToPageMapping(
            pageSize: (width, height), scaledSize: (scaledW, scaledH), crop1: (c1.x0, c1.y0), crop2: (c2.x0, c2.y0),
            dewarp: dewarp, beforeCanvas: (max(0, ow), max(0, oh)), canvasContent: (dims.width, dims.height))
        return Result(pixels: out, width: max(0, ow), height: max(0, oh),
                      canvasWidth: dims.width, canvasHeight: dims.height, toPage: toPage)
    }

    // MARK: - staff_parsing helpers

    /// `_calculate_region`: `[int(x_min), int(y_min), int(x_max), int(y_max)]` (truncation toward zero).
    static func calculateRegion(_ staff: HomrStaff, _ regions: [(Double, Double)]) -> [Int] {
        let u = staff.averageUnitSize
        let xMin = staff.minX - 2 * u
        let xMax = staff.maxX + 2 * u
        let above = regions.filter { $0.0 < staff.minY }.map { $0.1 }.max() ?? 0
        let below = regions.filter { $0.1 > staff.maxY }.map { $0.0 }.min() ?? 1e12
        let yMin = max(staff.minY - 4 * u, above)
        let yMax = min(staff.maxY + 4 * u, below)
        return [Int(xMin), Int(yMin), Int(xMax), Int(yMax)]
    }

    /// `crop_image_and_return_new_top` bounds: `_limit_x/_limit_y` = clamp(round-half-even(v), 0, dim - 1),
    /// numpy slice `[y1:y2, x1:x2]` (so the last row / column is never included).
    static func cropBounds(width: Int, height: Int, _ r: [Double]) -> (x0: Int, y0: Int, x1: Int, y1: Int) {
        func limit(_ v: Double, _ dim: Int) -> Int {
            let rv = v.rounded(.toNearestOrEven)
            let iv = rv.isFinite ? Int(max(-1e15, min(1e15, rv))) : 0
            return max(0, min(dim - 1, iv))
        }
        let x0 = limit(min(r[0], r[2]), width), x1 = limit(max(r[0], r[2]), width)
        let y0 = limit(min(r[1], r[3]), height), y1 = limit(max(r[1], r[3]), height)
        return (x0, y0, max(x0, x1), max(y0, y1))
    }

    /// `remove_black_contours_at_edges_of_image(gray, unit_size)`: `threshold(97, BINARY)` inverted, then
    /// every contour box at least `2 * unit_size` wide and high that touches the image edge and whose
    /// inverted-threshold mean is ≥ 127 is painted white.
    static func removeBlackContoursAtEdges(_ gray: inout [UInt8], width w: Int, height h: Int, unitSize: Double) {
        let fg = gray.map { $0 <= 97 } // 255 - (gray > 97 ? 255 : 0) != 0
        let threshold = 2 * unitSize
        var paint: [CVGeometry.Rect] = []
        for r in CVGeometry.contourBoundingRects(foreground: fg, width: w, height: h) {
            if Double(r.width) < threshold || Double(r.height) < threshold { continue }
            let atEdge = r.x == 0 || r.y == 0 || r.x + r.width == w || r.y + r.height == h
            if !atEdge { continue }
            var dark = 0
            for y in r.y..<(r.y + r.height) {
                for x in r.x..<(r.x + r.width) where fg[y * w + x] { dark += 1 }
            }
            // np.mean(thresh[box]) < 127 with thresh in {0, 255}: exact as integers
            if 255 * dark < 127 * r.width * r.height { continue }
            paint.append(r)
        }
        for r in paint {
            for y in r.y..<(r.y + r.height) {
                for x in r.x..<(r.x + r.width) { gray[y * w + x] = 255 }
            }
        }
    }

    // MARK: - staff_dewarping

    /// `dewarp_staff_image`: control points from the staff grid, then `calculate_dewarp_transformation`.
    /// Any failure returns nil (homr catches the exception and uses `StaffDewarping(None)` = no warp).
    static func dewarpTransform(width: Int, height: Int, staff: HomrStaff) -> PiecewiseAffine? {
        let (span, optimal) = spanAndOptimalPoints(width: width, height: height, staff: staff)
        return try? dewarpTransformation(width: width, height: height, source: span, destination: optimal)
    }

    /// `calculate_span_and_optimal_points`.
    static func spanAndOptimalPoints(width: Int, height: Int, staff: HomrStaff) -> ([[(Int, Int)]], [[(Int, Int)]]) {
        var span: [[(Int, Int)]] = [], optimal: [[(Int, Int)]] = []
        let step = Int(Double(height) / 6)
        if step == 0 { return (span, optimal) }
        var firstYOffset: Double? = nil
        var y = 2
        while y < height - 2 {
            var line: [(Int, Int)] = []
            var x = 2
            while x < width {
                if let p = staff.getAt(Double(x)) {
                    let yOffset = p.y[2]
                    var yDelta = 0
                    if firstYOffset == nil || firstYOffset == 0 { // `if not first_y_offset`
                        firstYOffset = yOffset
                        yDelta = 0
                    } else {
                        let d = yOffset - firstYOffset!
                        yDelta = Int(d) // int() truncates toward zero
                    }
                    let pt = (x, y + yDelta)
                    let margin = 10
                    if !(pt.0 < margin || pt.0 > width - margin || pt.1 < margin || pt.1 > height - margin) {
                        line.append(pt)
                    }
                }
                x += 80
            }
            if line.count > 2 {
                let avg = Double(line.reduce(0) { $0 + $1.1 }) / Double(line.count)
                span.append(line)
                optimal.append(line.map { ($0.0, Int(avg)) })
            }
            y += step
        }
        return (span, optimal)
    }

    /// `calculate_dewarp_transformation`: pin each line at x = 0 and x = width, add the image's top and
    /// bottom edges, and estimate the piecewise-affine transform (float32 points).
    static func dewarpTransformation(width: Int, height: Int, source: [[(Int, Int)]], destination: [[(Int, Int)]]) throws -> PiecewiseAffine {
        func prep(_ lines: [[(Int, Int)]]) -> [CVGeometry.Point2f] {
            var ls = lines.map { l -> [(Int, Int)] in [(0, l[0].1)] + l + [(width, l[l.count - 1].1)] }
            ls.insert([(0, 0), (width, 0)], at: 0)
            ls.append([(0, height), (width, height)])
            return ls.flatMap { $0 }.map { CVGeometry.Point2f(x: Float($0.0), y: Float($0.1)) }
        }
        return try PiecewiseAffine(src: prep(source), dst: prep(destination))
    }

    /// `PiecewiseAffineTransform` (estimate + warp_image) over `DelaunayTriangulation` (cv2.Subdiv2D).
    public struct PiecewiseAffine: Sendable {
        let src: [CVGeometry.Point2f]
        let dst: [CVGeometry.Point2f]
        let simplices: [[Int]]
        let valid: [Bool] // affine_matrices[i] is not None

        init(src: [CVGeometry.Point2f], dst: [CVGeometry.Point2f]) throws {
            self.src = src; self.dst = dst
            simplices = try Self.triangulate(src)
            valid = simplices.map { s in
                !Self.isDegenerate(s.map { src[$0] }) && !Self.isDegenerate(s.map { dst[$0] })
            }
        }

        /// `DelaunayTriangulation._triangulate`.
        static func triangulate(_ points: [CVGeometry.Point2f]) throws -> [[Int]] {
            guard points.count >= 3 else { throw StaffPrepare.Error.badGeometry("need at least 3 points") }
            let r = CVGeometry.boundingRect(points)
            var subdiv = Subdiv2D(x: r.x - 10, y: r.y - 10, width: r.width + 20, height: r.height + 20)
            for p in points { try subdiv.insert(p) }
            var out: [[Int]] = []
            for t in subdiv.triangleList() {
                let idx = t.map { findPointIndex($0, points) }
                if let a = idx[0], let b = idx[1], let c = idx[2] { out.append([a, b, c]) }
            }
            return out
        }

        /// `_find_point_index`: first index of the nearest point (float32 norm), if closer than 1e-3.
        static func findPointIndex(_ p: CVGeometry.Point2f, _ points: [CVGeometry.Point2f]) -> Int? {
            var best = 0
            var bestD = Float.infinity
            for (i, q) in points.enumerated() {
                let dx = q.x - p.x, dy = q.y - p.y
                let d = (dx * dx + dy * dy).squareRoot()
                if d < bestD { bestD = d; best = i }
            }
            return bestD < 1e-3 ? best : nil
        }

        /// `_is_degenerate_triangle` in float32 (numpy float32 arrays; `/ 2.0` stays float32 under NEP 50).
        static func isDegenerate(_ t: [CVGeometry.Point2f]) -> Bool {
            let v1x = t[1].x - t[0].x, v1y = t[1].y - t[0].y
            let v2x = t[2].x - t[0].x, v2y = t[2].y - t[0].y
            let area = abs(v1x * v2y - v1y * v2x) / 2
            return area < Float(1e-6)
        }

        /// `warp_image(image, fill_color, order=1)` for a grayscale image.
        func warp(_ image: [UInt8], width: Int, height: Int, fill: UInt8) -> [UInt8] {
            var output = [UInt8](repeating: fill, count: width * height)
            for (si, s) in simplices.enumerated() where valid[si] {
                let st = s.map { src[$0] }, dt = s.map { dst[$0] }
                if Self.isDegenerate(st) || Self.isDegenerate(dt) { continue }
                let sr = CVGeometry.boundingRect(st), dr = CVGeometry.boundingRect(dt)
                if sr.width <= 0 || sr.height <= 0 || dr.width <= 0 || dr.height <= 0 { continue }
                let sc = st.map { CVGeometry.Point2f(x: $0.x - Float(sr.x), y: $0.y - Float(sr.y)) }
                let dc = dt.map { CVGeometry.Point2f(x: $0.x - Float(dr.x), y: $0.y - Float(dr.y)) }
                if Self.isDegenerate(sc) || Self.isDegenerate(dc) { continue }
                let m = CVGeometry.getAffineTransform(sc, dc)
                // image[sr.y : sr.y + h, sr.x : sr.x + w] (numpy slice semantics)
                let ys = pySlice(sr.y, sr.y + sr.height, height), xs = pySlice(sr.x, sr.x + sr.width, width)
                if ys.1 <= ys.0 || xs.1 <= xs.0 { continue }
                let view = CVGeometry.GrayView(pixels: image, offset: ys.0 * width + xs.0, stride: width,
                                               width: xs.1 - xs.0, height: ys.1 - ys.0)
                let warped = CVGeometry.warpAffineLinear(view, m, dstWidth: dr.width, dstHeight: dr.height, borderValue: fill)
                var mask = [UInt8](repeating: 0, count: dr.width * dr.height)
                CVGeometry.fillConvexPoly(&mask, width: dr.width, height: dr.height,
                                          dc.map { (x: Int($0.x), y: Int($0.y)) }, value: 255)
                let y1 = dr.y, y2 = dr.y + dr.height, x1 = dr.x, x2 = dr.x + dr.width
                let y1c = max(0, y1), y2c = min(height, y2), x1c = max(0, x1), x2c = min(width, x2)
                if y2c <= y1c || x2c <= x1c { continue }
                for y in y1c..<y2c {
                    for x in x1c..<x2c {
                        let mi = (y - y1) * dr.width + (x - x1)
                        if mask[mi] > 0 { output[y * width + x] = warped[mi] }
                    }
                }
            }
            return output
        }

        /// Python slice `[start:stop]` on an axis of length `n` (negative indices wrap, then clamp).
        func pySlice(_ start: Int, _ stop: Int, _ n: Int) -> (Int, Int) {
            func norm(_ v: Int) -> Int { v < 0 ? max(0, v + n) : min(v, n) }
            return (norm(start), norm(stop))
        }
    }
}

// MARK: - homr.model Staff / StaffPoint (the fields prepare_staff_image reads)

/// numpy `add.reduce` for float64 (pairwise summation, 8-way unrolled blocks up to 128).
func numpyPairwiseSum(_ a: ArraySlice<Double>) -> Double {
    let n = a.count
    let b = a.startIndex
    if n < 8 {
        var r = 0.0
        for v in a { r += v }
        return r
    }
    if n <= 128 {
        var r = Array(a[b..<(b + 8)])
        var i = 8
        while i < n - (n % 8) {
            for j in 0..<8 { r[j] += a[b + i + j] }
            i += 8
        }
        var res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]))
        while i < n { res += a[b + i]; i += 1 }
        return res
    }
    var n2 = n / 2
    n2 -= n2 % 8
    return numpyPairwiseSum(a[b..<(b + n2)]) + numpyPairwiseSum(a[(b + n2)...])
}

func numpyMean(_ a: [Double]) -> Double { numpyPairwiseSum(a[...]) / Double(a.count) }

/// `np.median`: middle element, or the mean of the two middle elements.
func numpyMedian(_ a: [Double]) -> Double {
    let s = a.sorted()
    let n = s.count
    if n % 2 == 1 { return s[n / 2] }
    return numpyMean([s[n / 2 - 1], s[n / 2]])
}

struct HomrStaffPoint {
    let x: Double
    let y: [Double]
    let averageUnitSize: Double

    init(x: Double, y: [Double]) {
        self.x = x
        self.y = y
        let diffs = zip(y.dropFirst(), y).map { $0 - $1 }
        averageUnitSize = diffs.isEmpty ? .nan : numpyMean(diffs)
    }
}

struct HomrStaff {
    let grid: [HomrStaffPoint]
    let minX: Double, maxX: Double, minY: Double, maxY: Double
    let averageUnitSize: Double

    init(_ grid: [HomrStaffPoint]) throws {
        guard let first = grid.first, let last = grid.last else {
            throw StaffPrepare.Error.badGeometry("empty grid")
        }
        for p in grid where p.y.isEmpty || p.y.count % 5 != 0 {
            throw StaffPrepare.Error.badGeometry("a staff must consist of 5, 10, ... lines (got \(p.y.count))")
        }
        self.grid = grid
        minX = first.x
        maxX = last.x
        minY = grid.map { $0.y.min()! }.min()!
        maxY = grid.map { $0.y.max()! }.max()!
        averageUnitSize = numpyMedian(grid.map { $0.averageUnitSize })
    }

    /// `Staff.get_at(x)`: first grid point with minimal |p.x - x|, nil if farther than 50 px.
    func getAt(_ x: Double) -> HomrStaffPoint? {
        var best = grid[0]
        var bestD = abs(best.x - x)
        for p in grid.dropFirst() {
            let d = abs(p.x - x)
            if d < bestD { best = p; bestD = d }
        }
        return bestD > 50 ? nil : best
    }

    /// `Staff.transform_coordinates`: every (x, y_i) mapped; the new x is the numpy mean of the mapped xs.
    func transformed(_ f: (Double, Double) -> (Double, Double)) throws -> HomrStaff {
        try HomrStaff(grid.map { p in
            let xy = p.y.map { f(p.x, $0) }
            return HomrStaffPoint(x: numpyMean(xy.map { $0.0 }), y: xy.map { $0.1 })
        })
    }
}

// MARK: - Public conveniences

extension StaffPrepare {
    /// Decode `geometry.json` (the oracle format: `grid` of `{x, y[], angle}` + `regions`; extra keys ignored).
    public static func loadGeometry(_ url: URL) throws -> StaffGeometry {
        try JSONDecoder().decode(StaffGeometry.self, from: Data(contentsOf: url))
    }

    /// `center_image_on_canvas(prepared, image_dimensions)`: the 256×1280 uint8 canvas homr feeds the encoder.
    public static func canvas(_ r: Result) throws -> [UInt8] {
        try StaffPreprocessing.centerOnCanvas(grayscale: r.pixels, width: r.width, height: r.height,
                                              targetWidth: r.canvasWidth, targetHeight: r.canvasHeight)
    }

    /// Load a 2-D `uint8` `.npy` (`|u1`, C order), e.g. the oracle's `prepared.npy`.
    public static func loadGrayNPY(_ url: URL) throws -> (pixels: [UInt8], width: Int, height: Int) {
        let b = [UInt8](try Data(contentsOf: url))
        guard b.count > 10, b[0] == 0x93, String(decoding: b[1..<6], as: UTF8.self) == "NUMPY" else {
            throw StaffTensor.LoadError.notNPY("missing \\x93NUMPY magic")
        }
        let lo: Int = Int(b[8]) | (Int(b[9]) << 8)
        let headerLen: Int, start: Int
        if b[6] == 1 {
            headerLen = lo; start = 10
        } else {
            guard b.count >= 12 else { throw StaffTensor.LoadError.notNPY("truncated header") }
            let hi: Int = (Int(b[10]) << 16) | (Int(b[11]) << 24)
            headerLen = lo | hi; start = 12
        }
        guard b.count >= start + headerLen else { throw StaffTensor.LoadError.notNPY("truncated header") }
        let compact = String(decoding: b[start..<(start + headerLen)], as: UTF8.self).replacingOccurrences(of: " ", with: "")
        guard compact.contains("'descr':'|u1'"), compact.contains("'fortran_order':False"),
              let open = compact.range(of: "'shape':("),
              let close = compact[open.upperBound...].firstIndex(of: ")") else {
            throw StaffTensor.LoadError.unsupportedNPY("need 2-D '|u1' C order: \(compact)")
        }
        let shape = compact[open.upperBound..<close].split(separator: ",").compactMap { Int($0) }
        guard shape.count == 2, b.count - start - headerLen == shape[0] * shape[1] else {
            throw StaffTensor.LoadError.unsupportedNPY("shape \(shape) vs \(b.count - start - headerLen) bytes")
        }
        return (Array(b[(start + headerLen)...]), shape[1], shape[0])
    }
}

extension StaffTensor {
    /// homr's page-region path: `prepare_staff_image` (region crop, resize, dewarp, edge-contour cleanup,
    /// `center_image_on_canvas` at the region's canvas size) → `ConvertToArray`. `geometry` is the staff
    /// found by homr's SegNet + staff detection (not ported yet; pass it explicitly).
    public static func fromPage(grayscale pixels: [UInt8], width: Int, height: Int, geometry: StaffGeometry) throws -> StaffTensor {
        let r = try StaffPrepare.prepareStaffImage(page: pixels, width: width, height: height, geometry: geometry)
        return try fromCanvas(StaffPrepare.canvas(r))
    }
}
