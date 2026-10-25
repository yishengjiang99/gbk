// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure-Swift, bit-exact ports of the OpenCV 5.0.0 primitives that homr's staff dewarp
// (liebharc/homr @ 7d97c3cee4ad772b50266fdf9dc78bbf9064701e, homr/staff_dewarping.py and
// homr/staff_parsing.py, AGPL-3.0) calls through cv2. Reference: opencv/opencv tag 5.0.0 as shipped
// in opencv-python 5.0.0.93 (x86_64, AVX2 dispatch, ALGO_HINT_ACCURATE):
//   cv::boundingRect (float point set)     modules/geometry/src/geometry.cpp  pointSetBoundingRect
//   cv::getAffineTransform + solve(LU)     modules/geometry/src/geometry.cpp, modules/core/src/matrix_decomp.cpp LUImpl
//   cv::warpAffine INTER_LINEAR 8UC1       modules/imgproc/src/imgwarp.cpp + warp_kernels.simd.hpp
//                                          (warpAffineLinearInvoker_8UC1, float32 coordinates + FMA)
//   cv::fillConvexPoly (LINE_8, shift 0)   modules/imgproc/src/drawing.cpp FillConvexPoly + Line/LineIterator
//   cv::Subdiv2D (Delaunay)                modules/geometry/src/subdivision2d.cpp
//   cv::findContours(RETR_TREE) bboxes     equivalent: 8-connected foreground components + 4-connected
//                                          holes grown by 1 (checked against cv2 on random images)
// No OpenCV dependency; runs on Linux and iOS.
import Foundation

enum CVGeometry {
    struct Rect: Equatable {
        var x: Int, y: Int, width: Int, height: Int
    }

    struct Point2f: Equatable {
        var x: Float, y: Float
    }

    // MARK: - boundingRect (CV_32F points)

    /// `pointSetBoundingRect` for float points: `cvFloor` of min / max, width = floor(max) - floor(min) + 1.
    static func boundingRect(_ pts: [Point2f]) -> Rect {
        guard let f = pts.first else { return Rect(x: 0, y: 0, width: 0, height: 0) }
        var xmin = Int(f.x.rounded(.down)), xmax = xmin
        var ymin = Int(f.y.rounded(.down)), ymax = ymin
        for p in pts.dropFirst() {
            let x = Int(p.x.rounded(.down)), y = Int(p.y.rounded(.down))
            xmin = min(xmin, x); xmax = max(xmax, x)
            ymin = min(ymin, y); ymax = max(ymax, y)
        }
        return Rect(x: xmin, y: ymin, width: xmax - xmin + 1, height: ymax - ymin + 1)
    }

    // MARK: - getAffineTransform

    /// `cv::getAffineTransform(src[3], dst[3])`: 6x6 system solved with `LUImpl<double>`
    /// (partial pivoting, eps = DBL_EPSILON*100; LAPACK is only used from 100x100 up). Returns the
    /// 2x3 matrix row-major. A singular system leaves OpenCV's output at zero, as here.
    static func getAffineTransform(_ src: [Point2f], _ dst: [Point2f]) -> [Double] {
        precondition(src.count == 3 && dst.count == 3)
        var a = [Double](repeating: 0, count: 36)
        var b = [Double](repeating: 0, count: 6)
        for i in 0..<3 {
            let j = i * 12, k = i * 12 + 6
            a[j] = Double(src[i].x); a[k + 3] = Double(src[i].x)
            a[j + 1] = Double(src[i].y); a[k + 4] = Double(src[i].y)
            a[j + 2] = 1; a[k + 5] = 1
            b[i * 2] = Double(dst[i].x)
            b[i * 2 + 1] = Double(dst[i].y)
        }
        if luSolve(&a, m: 6, &b) == 0 { return [Double](repeating: 0, count: 6) }
        return b
    }

    /// `LUImpl<double>(A, m, b, n = 1, DBL_EPSILON*100)`; returns 0 if singular, else ±1.
    static func luSolve(_ A: inout [Double], m: Int, _ b: inout [Double]) -> Int {
        let eps = Double.ulpOfOne * 100
        var p = 1
        for i in 0..<m {
            var k = i
            for j in (i + 1)..<max(m, i + 1) where abs(A[j * m + i]) > abs(A[k * m + i]) { k = j }
            if abs(A[k * m + i]) < eps { return 0 }
            if k != i {
                for j in i..<m { A.swapAt(i * m + j, k * m + j) }
                b.swapAt(i, k)
                p = -p
            }
            let d = -1 / A[i * m + i]
            for j in (i + 1)..<max(m, i + 1) {
                let alpha = A[j * m + i] * d
                for kk in (i + 1)..<max(m, i + 1) { A[j * m + kk] += alpha * A[i * m + kk] }
                b[j] += alpha * b[i]
            }
        }
        for i in stride(from: m - 1, through: 0, by: -1) {
            var s = b[i]
            for k in (i + 1)..<max(m, i + 1) { s -= A[i * m + k] * b[k] }
            b[i] = s / A[i * m + i]
        }
        return p
    }

    // MARK: - warpAffine (INTER_LINEAR, BORDER_CONSTANT, CV_8UC1)

    /// A read-only 8-bit single-channel view (numpy slice semantics: `stride` = parent row length).
    struct GrayView {
        var pixels: [UInt8]
        var offset: Int
        var stride: Int
        var width: Int
        var height: Int
        @inline(__always) func at(_ x: Int, _ y: Int) -> UInt8 { pixels[offset + y * stride + x] }
    }

    /// `cv::warpAffine(src, M, (dw, dh), INTER_LINEAR, BORDER_CONSTANT, borderValue)` for 8UC1, forward `M`.
    /// cv::warpAffine inverts M in double, then `warpAffineLinearInvoker_8UC1` casts it to float and maps
    /// each destination pixel with float32 FMAs: the AVX2 body (16 pixels per step) computes
    /// `sx = fma(M0, x, fma(y, M1, M2))`; the scalar tail (last `dw % 16` columns) computes
    /// `x*M0 + y*M1 + M2` as GCC contracts it. Bilinear weights are `sx - floor(sx)`, interpolation is
    /// `fma(a, p01 - p00, p00)` / `fma(b, v1 - v0, v0)` in float, out-of-image taps read `borderValue`,
    /// and the result is rounded half-to-even and saturated to 0...255.
    static func warpAffineLinear(_ src: GrayView, _ fwd: [Double], dstWidth dw: Int, dstHeight dh: Int,
                                 borderValue: UInt8) -> [UInt8] {
        var M = fwd
        var D = M[0] * M[4] - M[1] * M[3]
        D = D != 0 ? 1.0 / D : 0
        let A11 = M[4] * D, A22 = M[0] * D
        M[0] = A11; M[1] *= -D
        M[3] *= -D; M[4] = A22
        let b1 = -M[0] * M[2] - M[1] * M[5]
        let b2 = -M[3] * M[2] - M[4] * M[5]
        M[2] = b1; M[5] = b2
        let m = M.map { Float($0) }

        var dst = [UInt8](repeating: borderValue, count: dw * dh)
        let sw = src.width, sh = src.height
        let bval = Float(borderValue)
        let uf = 16
        @inline(__always) func tap(_ x: Int, _ y: Int) -> Float {
            (UInt(bitPattern: x) < UInt(sw) && UInt(bitPattern: y) < UInt(sh)) ? Float(src.at(x, y)) : bval
        }
        @inline(__always) func sample(_ sx: Float, _ sy: Float) -> UInt8 {
            let fx = sx.rounded(.down), fy = sy.rounded(.down)
            guard fx.magnitude < 1e9, fy.magnitude < 1e9 else { return borderValue }
            let ix = Int(fx), iy = Int(fy)
            let a = sx - fx, b = sy - fy
            let p00 = tap(ix, iy), p01 = tap(ix + 1, iy), p10 = tap(ix, iy + 1), p11 = tap(ix + 1, iy + 1)
            let r0 = p00.addingProduct(a, p01 - p00)
            let r1 = p10.addingProduct(a, p11 - p10)
            let r = r0.addingProduct(b, r1 - r0)
            let q = r.rounded(.toNearestOrEven)
            return UInt8(max(0, min(255, q)))
        }
        for y in 0..<dh {
            let fy = Float(y)
            let row = y * dw
            var x = 0
            // SIMD body (CV_WARPAFFINE_VECTOR_COMPUTE_MAPPED_COORD1/2): M_x = float(y*M1 + M2), contracted.
            let mx = m[2].addingProduct(fy, m[1])
            let my = m[5].addingProduct(fy, m[4])
            while x <= dw - uf {
                for i in 0..<uf {
                    let xf = Float(x + i)
                    dst[row + x + i] = sample(mx.addingProduct(m[0], xf), my.addingProduct(m[3], xf))
                }
                x += uf
            }
            // Scalar tail: `x*M[0] + y*M[1] + M[2]`, GCC -ffp-contract=fast: fma(x, M0, y*M1) + M2.
            while x < dw {
                let xf = Float(x)
                let sx = (fy * m[1]).addingProduct(xf, m[0]) + m[2]
                let sy = (fy * m[4]).addingProduct(xf, m[3]) + m[5]
                dst[row + x] = sample(sx, sy)
                x += 1
            }
        }
        return dst
    }

    // MARK: - fillConvexPoly (LINE_8, shift 0)

    private static let xyShift = 16
    private static let xyOne: Int64 = 1 << 16

    /// `cv::fillConvexPoly(img, pts, color)` with the defaults homr uses (lineType 8, shift 0):
    /// outline drawn with `Line` (8-connected `LineIterator`, clipped), then the scanline fill.
    static func fillConvexPoly(_ img: inout [UInt8], width: Int, height: Int, _ v: [(x: Int, y: Int)], value: UInt8) {
        let npts = v.count
        guard npts > 0 else { return }
        let delta1 = xyOne >> 1, delta2 = xyOne >> 1
        var imin = 0
        var xmin = Int64(v[0].x), xmax = xmin, ymin = Int64(v[0].y), ymax = ymin
        var p0 = (x: Int64(v[npts - 1].x) << xyShift, y: Int64(v[npts - 1].y) << xyShift)
        for i in 0..<npts {
            let px = Int64(v[i].x), py = Int64(v[i].y)
            if py < ymin { ymin = py; imin = i }
            ymax = max(ymax, py); xmax = max(xmax, px); xmin = min(xmin, px)
            let p = (x: px << xyShift, y: py << xyShift)
            line(&img, width: width, height: height,
                 (Int(p0.x >> xyShift), Int(p0.y >> xyShift)), (Int(p.x >> xyShift), Int(p.y >> xyShift)), value)
            p0 = p
        }
        if npts < 3 || xmax < 0 || ymax < 0 || xmin >= Int64(width) || ymin >= Int64(height) { return }
        ymax = min(ymax, Int64(height - 1))

        struct Edge { var idx: Int; var di: Int; var x: Int64; var dx: Int64; var ye: Int }
        var edge = [Edge(idx: imin, di: 1, x: -xyOne, dx: 0, ye: Int(ymin)),
                    Edge(idx: imin, di: npts - 1, x: -xyOne, dx: 0, ye: Int(ymin))]
        var edges = npts
        var y = Int(ymin)
        repeat {
            for i in 0..<2 where y >= edge[i].ye {
                var idx0 = edge[i].idx
                let di = edge[i].di
                var idx = idx0 + di
                if idx >= npts { idx -= npts }
                // `for (; edges-- > 0; )`: test, then decrement (leaves -1 when exhausted).
                while true {
                    let more = edges > 0
                    edges -= 1
                    if !more { break }
                    let ty = v[idx].y
                    if ty > y {
                        let xs = Int64(v[idx0].x) << xyShift
                        let xe = Int64(v[idx].x) << xyShift
                        edge[i].ye = ty
                        let dyy = Int64(ty - y)
                        edge[i].dx = ((xe - xs) * 2 + dyy) / (2 * dyy) // C++ truncating division
                        edge[i].x = xs
                        edge[i].idx = idx
                        break
                    }
                    idx0 = idx
                    idx += di
                    if idx >= npts { idx -= npts }
                }
            }
            if edges < 0 { break }
            if y >= 0 {
                var left = 0, right = 1
                if edge[0].x > edge[1].x { left = 1; right = 0 }
                var xx1 = Int((edge[left].x + delta1) >> xyShift)
                var xx2 = Int((edge[right].x + delta2) >> xyShift)
                if xx2 >= 0 && xx1 < width {
                    if xx1 < 0 { xx1 = 0 }
                    if xx2 >= width { xx2 = width - 1 }
                    if xx1 <= xx2 { for xx in xx1...xx2 { img[y * width + xx] = value } }
                }
            }
            edge[0].x += edge[0].dx
            edge[1].x += edge[1].dx
            y += 1
        } while y <= Int(ymax)
    }

    /// `Line(img, pt1, pt2, color, 8)`: `LineIterator(img, pt1, pt2, 8, leftToRight = true)`.
    static func line(_ img: inout [UInt8], width: Int, height: Int, _ a: (Int, Int), _ b: (Int, Int), _ value: UInt8) {
        var pt1 = (x: Int64(a.0), y: Int64(a.1)), pt2 = (x: Int64(b.0), y: Int64(b.1))
        if UInt64(bitPattern: pt1.x) >= UInt64(width) || UInt64(bitPattern: pt2.x) >= UInt64(width)
            || UInt64(bitPattern: pt1.y) >= UInt64(height) || UInt64(bitPattern: pt2.y) >= UInt64(height) {
            if !clipLine(width: Int64(width), height: Int64(height), &pt1, &pt2) { return }
            // clipLine(Size, Point&, Point&) narrows back to int
            pt1 = (Int64(Int32(truncatingIfNeeded: pt1.x)), Int64(Int32(truncatingIfNeeded: pt1.y)))
            pt2 = (Int64(Int32(truncatingIfNeeded: pt2.x)), Int64(Int32(truncatingIfNeeded: pt2.y)))
        }
        var deltaX = 1, deltaY = 1
        var dx = Int(pt2.x - pt1.x), dy = Int(pt2.y - pt1.y)
        var p = (x: Int(pt1.x), y: Int(pt1.y))
        if dx < 0 { dx = -dx; dy = -dy; p = (Int(pt2.x), Int(pt2.y)) } // leftToRight
        if dy < 0 { dy = -dy; deltaY = -1 }
        let vert = dy > dx
        if vert { swap(&dx, &dy); swap(&deltaX, &deltaY) }
        var err = dx - (dy + dy)
        let plusDelta = dx + dx, minusDelta = -(dy + dy)
        var minusShift = deltaX, plusShift = 0, minusStep = 0, plusStep = deltaY
        let count = dx + 1
        if vert { swap(&plusStep, &plusShift); swap(&minusStep, &minusShift) }
        // ptmode == false: ptr moves by minusStep*step + minusShift (+ plus* when err < 0).
        for _ in 0..<count {
            img[p.y * width + p.x] = value
            let mask = err < 0 ? -1 : 0
            err += minusDelta + (plusDelta & mask)
            p.x += minusShift + (plusShift & mask)
            p.y += minusStep + (plusStep & mask)
        }
    }

    /// `clipLine(Size2l, Point2l&, Point2l&)`.
    static func clipLine(width: Int64, height: Int64, _ pt1: inout (x: Int64, y: Int64), _ pt2: inout (x: Int64, y: Int64)) -> Bool {
        let right = width - 1, bottom = height - 1
        if width <= 0 || height <= 0 { return false }
        func code(_ p: (x: Int64, y: Int64)) -> Int {
            (p.x < 0 ? 1 : 0) + (p.x > right ? 2 : 0) + (p.y < 0 ? 4 : 0) + (p.y > bottom ? 8 : 0)
        }
        /// `(int64)((double)num * (double)mul / (double)den)`, cv::clipLine's step (split for the iOS type checker).
        func clipStep(_ num: Int64, _ mul: Int64, _ den: Int64) -> Int64 {
            let n: Double = Double(num)
            let m: Double = Double(mul)
            let d: Double = Double(den)
            let q: Double = n * m / d
            return Int64(q)
        }
        var c1 = code(pt1), c2 = code(pt2)
        if (c1 & c2) == 0 && (c1 | c2) != 0 {
            var a: Int64
            if c1 & 12 != 0 {
                a = c1 < 8 ? 0 : bottom
                pt1.x += clipStep(a - pt1.y, pt2.x - pt1.x, pt2.y - pt1.y)
                pt1.y = a
                c1 = (pt1.x < 0 ? 1 : 0) + (pt1.x > right ? 2 : 0)
            }
            if c2 & 12 != 0 {
                a = c2 < 8 ? 0 : bottom
                pt2.x += clipStep(a - pt2.y, pt2.x - pt1.x, pt2.y - pt1.y)
                pt2.y = a
                c2 = (pt2.x < 0 ? 1 : 0) + (pt2.x > right ? 2 : 0)
            }
            if (c1 & c2) == 0 && (c1 | c2) != 0 {
                if c1 != 0 {
                    a = c1 == 1 ? 0 : right
                    pt1.y += clipStep(a - pt1.x, pt2.y - pt1.y, pt2.x - pt1.x)
                    pt1.x = a
                    c1 = 0
                }
                if c2 != 0 {
                    a = c2 == 1 ? 0 : right
                    pt2.y += clipStep(a - pt2.x, pt2.y - pt1.y, pt2.x - pt1.x)
                    pt2.x = a
                    c2 = 0
                }
            }
        }
        return (c1 | c2) == 0
    }

    // MARK: - findContours(RETR_TREE) bounding rects

    /// Bounding rects of every contour `cv2.findContours(binary, RETR_TREE, CHAIN_APPROX_SIMPLE)` returns
    /// (order not preserved; homr only uses the set). Outer borders = 8-connected foreground components;
    /// hole borders = 4-connected background components that do not reach the (zero-padded) image frame,
    /// grown by one pixel on each side (the traced border pixels surround the hole).
    static func contourBoundingRects(foreground fg: [Bool], width w: Int, height h: Int) -> [Rect] {
        var rects: [Rect] = []
        var seen = [Bool](repeating: false, count: w * h)
        var stack: [Int] = []
        func flood(_ start: Int, matches: (Int) -> Bool, eight: Bool) -> (Rect, Bool) {
            var x0 = Int.max, y0 = Int.max, x1 = Int.min, y1 = Int.min
            var touchesFrame = false
            stack.removeAll(keepingCapacity: true)
            stack.append(start); seen[start] = true
            while let i = stack.popLast() {
                let x = i % w, y = i / w
                x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y)
                if x == 0 || y == 0 || x == w - 1 || y == h - 1 { touchesFrame = true }
                for dy in -1...1 {
                    for dx in -1...1 where !(dx == 0 && dy == 0) {
                        if !eight && dx != 0 && dy != 0 { continue }
                        let nx = x + dx, ny = y + dy
                        if nx < 0 || ny < 0 || nx >= w || ny >= h { continue }
                        let j = ny * w + nx
                        if !seen[j] && matches(j) { seen[j] = true; stack.append(j) }
                    }
                }
            }
            return (Rect(x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1), touchesFrame)
        }
        for i in 0..<(w * h) where fg[i] && !seen[i] {
            rects.append(flood(i, matches: { fg[$0] }, eight: true).0)
        }
        for i in 0..<(w * h) where !fg[i] && !seen[i] {
            let (r, frame) = flood(i, matches: { !fg[$0] }, eight: false)
            if !frame { rects.append(Rect(x: r.x - 1, y: r.y - 1, width: r.width + 2, height: r.height + 2)) }
        }
        return rects
    }
}

// MARK: - Subdiv2D

/// Port of `cv::Subdiv2D` (Delaunay by incremental insertion over a quad-edge structure):
/// `initDelaunay(Rect)`, `insert`, `locate`, `getTriangleList`. Float32 vertices, double predicates,
/// same edge allocation order, so the triangle list (and its order) matches OpenCV.
struct Subdiv2D {
    enum Failure: Error { case outOfRange, badSize, invalidLocation }

    private struct QuadEdge {
        var next: (Int, Int, Int, Int) = (0, 0, 0, 0)
        var pt: (Int, Int, Int, Int) = (0, 0, 0, 0)
        init() {}
        init(_ e: Int) { next = (e, e + 3, e + 2, e + 1) }
    }
    private struct Vertex {
        var pt = CVGeometry.Point2f(x: 0, y: 0)
        var firstEdge = 0
        var type = -1
    }

    private var qedges: [QuadEdge] = []
    private var vtx: [Vertex] = []
    private var freeQEdge = 0, freePoint = 0, recentEdge = 0
    private var topLeft = CVGeometry.Point2f(x: 0, y: 0), bottomRight = CVGeometry.Point2f(x: 0, y: 0)

    private static let nextAroundOrg = 0x00, nextAroundDst = 0x22, prevAroundOrg = 0x11, prevAroundDst = 0x33
    private static let nextAroundLeft = 0x13, nextAroundRight = 0x31, prevAroundLeft = 0x20, prevAroundRight = 0x02
    private static let fltEpsilon = Double(Float.ulpOfOne)

    /// `Subdiv2D(Rect(x, y, width, height))` → `initDelaunay`.
    init(x: Int, y: Int, width: Int, height: Int) {
        let bigCoord = 6 * Float(max(width, height))
        let rx = Float(x), ry = Float(y)
        topLeft = .init(x: rx, y: ry)
        bottomRight = .init(x: rx + Float(width), y: ry + Float(height))
        let ppA = CVGeometry.Point2f(x: rx + bigCoord, y: ry)
        let ppB = CVGeometry.Point2f(x: rx, y: ry + bigCoord)
        let ppC = CVGeometry.Point2f(x: rx - bigCoord, y: ry - bigCoord)
        vtx.append(Vertex())
        qedges.append(QuadEdge())
        freeQEdge = 0; freePoint = 0
        let pA = newPoint(ppA, false), pB = newPoint(ppB, false), pC = newPoint(ppC, false)
        let eAB = newEdge(), eBC = newEdge(), eCA = newEdge()
        setEdgePoints(eAB, pA, pB)
        setEdgePoints(eBC, pB, pC)
        setEdgePoints(eCA, pC, pA)
        splice(eAB, symEdge(eCA))
        splice(eBC, symEdge(eAB))
        splice(eCA, symEdge(eBC))
        recentEdge = eAB
    }

    private func nx(_ e: Int, _ k: Int) -> Int {
        let q = qedges[e >> 2].next
        switch k & 3 { case 0: return q.0; case 1: return q.1; case 2: return q.2; default: return q.3 }
    }
    private mutating func setNx(_ e: Int, _ k: Int, _ v: Int) {
        switch k & 3 {
        case 0: qedges[e >> 2].next.0 = v
        case 1: qedges[e >> 2].next.1 = v
        case 2: qedges[e >> 2].next.2 = v
        default: qedges[e >> 2].next.3 = v
        }
    }
    private func ptOf(_ e: Int, _ k: Int) -> Int {
        let q = qedges[e >> 2].pt
        switch k & 3 { case 0: return q.0; case 1: return q.1; case 2: return q.2; default: return q.3 }
    }
    private mutating func setPt(_ e: Int, _ k: Int, _ v: Int) {
        switch k & 3 {
        case 0: qedges[e >> 2].pt.0 = v
        case 1: qedges[e >> 2].pt.1 = v
        case 2: qedges[e >> 2].pt.2 = v
        default: qedges[e >> 2].pt.3 = v
        }
    }

    private func nextEdge(_ e: Int) -> Int { nx(e, e & 3) }
    private func rotateEdge(_ e: Int, _ r: Int) -> Int { (e & ~3) + ((e + r) & 3) }
    private func symEdge(_ e: Int) -> Int { e ^ 2 }
    private func getEdge(_ e: Int, _ t: Int) -> Int {
        let n = nx(e, (e + t) & 3)
        return (n & ~3) + ((n + (t >> 4)) & 3)
    }
    private func edgeOrg(_ e: Int) -> Int { ptOf(e, e & 3) }
    private func edgeDst(_ e: Int) -> Int { ptOf(e, (e + 2) & 3) }

    private mutating func splice(_ a: Int, _ b: Int) {
        let aNext = nx(a, a & 3), bNext = nx(b, b & 3)
        let aRot = rotateEdge(aNext, 1), bRot = rotateEdge(bNext, 1)
        let aRotNext = nx(aRot, aRot & 3), bRotNext = nx(bRot, bRot & 3)
        setNx(a, a & 3, bNext); setNx(b, b & 3, aNext)
        setNx(aRot, aRot & 3, bRotNext); setNx(bRot, bRot & 3, aRotNext)
    }
    private mutating func setEdgePoints(_ e: Int, _ o: Int, _ d: Int) {
        setPt(e, e & 3, o)
        setPt(e, (e + 2) & 3, d)
        vtx[o].firstEdge = e
        vtx[d].firstEdge = e ^ 2
    }
    private mutating func connectEdges(_ a: Int, _ b: Int) -> Int {
        let e = newEdge()
        splice(e, getEdge(a, Self.nextAroundLeft))
        splice(symEdge(e), b)
        setEdgePoints(e, edgeDst(a), edgeOrg(b))
        return e
    }
    private mutating func swapEdges(_ e: Int) {
        let se = symEdge(e)
        let a = getEdge(e, Self.prevAroundOrg), b = getEdge(se, Self.prevAroundOrg)
        splice(e, a); splice(se, b)
        setEdgePoints(e, edgeDst(a), edgeDst(b))
        splice(e, getEdge(a, Self.nextAroundLeft))
        splice(se, getEdge(b, Self.nextAroundLeft))
    }
    private static func triangleArea(_ a: CVGeometry.Point2f, _ b: CVGeometry.Point2f, _ c: CVGeometry.Point2f) -> Double {
        let ax: Double = Double(a.x), ay: Double = Double(a.y)
        let bx: Double = Double(b.x), by: Double = Double(b.y)
        let cx: Double = Double(c.x), cy: Double = Double(c.y)
        let lhs: Double = (bx - ax) * (cy - ay)
        let rhs: Double = (by - ay) * (cx - ax)
        return lhs - rhs
    }
    private func isRightOf(_ p: CVGeometry.Point2f, _ e: Int) -> Int {
        let a = Self.triangleArea(p, vtx[edgeDst(e)].pt, vtx[edgeOrg(e)].pt)
        return (a > 0 ? 1 : 0) - (a < 0 ? 1 : 0)
    }
    private mutating func newEdge() -> Int {
        if freeQEdge <= 0 {
            qedges.append(QuadEdge())
            freeQEdge = qedges.count - 1
        }
        let e = freeQEdge * 4
        freeQEdge = qedges[e >> 2].next.1
        qedges[e >> 2] = QuadEdge(e)
        return e
    }
    private mutating func deleteEdge(_ e: Int) {
        splice(e, getEdge(e, Self.prevAroundOrg))
        let se = symEdge(e)
        splice(se, getEdge(se, Self.prevAroundOrg))
        let q = e >> 2
        qedges[q].next.0 = 0
        qedges[q].next.1 = freeQEdge
        freeQEdge = q
    }
    private mutating func newPoint(_ p: CVGeometry.Point2f, _ isVirtual: Bool, _ firstEdge: Int = 0) -> Int {
        if freePoint == 0 {
            vtx.append(Vertex())
            freePoint = vtx.count - 1
        }
        let v = freePoint
        freePoint = vtx[v].firstEdge
        vtx[v] = Vertex(pt: p, firstEdge: firstEdge, type: isVirtual ? 1 : 0)
        return v
    }

    private static let ptlocError = -2, ptlocInside = 0, ptlocVertex = 1, ptlocOnEdge = 2

    private mutating func locate(_ p: CVGeometry.Point2f) throws -> (loc: Int, edge: Int, vertex: Int) {
        var vertex = 0
        let maxEdges = qedges.count * 4
        if p.x < topLeft.x || p.y < topLeft.y || p.x >= bottomRight.x || p.y >= bottomRight.y {
            throw Failure.outOfRange
        }
        var edge = recentEdge
        var location = Self.ptlocError
        var rightOfCurr = isRightOf(p, edge)
        if rightOfCurr > 0 { edge = symEdge(edge); rightOfCurr = -rightOfCurr }
        for _ in 0..<maxEdges {
            let onext = nextEdge(edge)
            let dprev = getEdge(edge, Self.prevAroundDst)
            let rOnext = isRightOf(p, onext)
            let rDprev = isRightOf(p, dprev)
            if rDprev > 0 {
                if rOnext > 0 || (rOnext == 0 && rightOfCurr == 0) { location = Self.ptlocInside; break }
                rightOfCurr = rOnext; edge = onext
            } else {
                if rOnext > 0 {
                    if rDprev == 0 && rightOfCurr == 0 { location = Self.ptlocInside; break }
                    rightOfCurr = rDprev; edge = dprev
                } else if rightOfCurr == 0 && isRightOf(vtx[edgeDst(onext)].pt, edge) >= 0 {
                    edge = symEdge(edge)
                } else {
                    rightOfCurr = rOnext; edge = onext
                }
            }
        }
        recentEdge = edge
        if location == Self.ptlocInside {
            let o = vtx[edgeOrg(edge)].pt, d = vtx[edgeDst(edge)].pt
            var t1 = Double(abs(p.x - o.x)); t1 += Double(abs(p.y - o.y))
            var t2 = Double(abs(p.x - d.x)); t2 += Double(abs(p.y - d.y))
            var t3 = Double(abs(o.x - d.x)); t3 += Double(abs(o.y - d.y))
            if t1 < Self.fltEpsilon {
                location = Self.ptlocVertex; vertex = edgeOrg(edge); edge = 0
            } else if t2 < Self.fltEpsilon {
                location = Self.ptlocVertex; vertex = edgeDst(edge); edge = 0
            } else if (t1 < t3 || t2 < t3) && abs(Self.triangleArea(p, o, d)) < Self.fltEpsilon {
                location = Self.ptlocOnEdge; vertex = 0
            }
        }
        if location == Self.ptlocError { edge = 0; vertex = 0 }
        return (location, edge, vertex)
    }

    private static func isPtInCircle3(_ pt: CVGeometry.Point2f, _ a: CVGeometry.Point2f, _ b: CVGeometry.Point2f, _ c: CVGeometry.Point2f) -> Int {
        let eps = Double(Float.ulpOfOne) * 0.125
        func norm2(_ p: CVGeometry.Point2f) -> Double {
            let x: Double = Double(p.x), y: Double = Double(p.y)
            let xx: Double = x * x
            let yy: Double = y * y
            return xx + yy
        }
        var val: Double = norm2(a) * triangleArea(b, c, pt)
        val -= norm2(b) * triangleArea(a, c, pt)
        val += norm2(c) * triangleArea(a, b, pt)
        val -= norm2(pt) * triangleArea(a, b, c)
        return val > eps ? 1 : val < -eps ? -1 : 0
    }

    @discardableResult
    mutating func insert(_ p: CVGeometry.Point2f) throws -> Int {
        var (location, currEdge, currPoint) = try locate(p)
        if location == Self.ptlocError { throw Failure.badSize }
        if location == Self.ptlocVertex { return currPoint }
        if location == Self.ptlocOnEdge {
            let deleted = currEdge
            currEdge = getEdge(currEdge, Self.prevAroundOrg)
            recentEdge = currEdge
            deleteEdge(deleted)
        } else if location != Self.ptlocInside {
            throw Failure.invalidLocation
        }
        currPoint = newPoint(p, false)
        var baseEdge = newEdge()
        let firstPoint = edgeOrg(currEdge)
        setEdgePoints(baseEdge, firstPoint, currPoint)
        splice(baseEdge, currEdge)
        repeat {
            baseEdge = connectEdges(currEdge, symEdge(baseEdge))
            currEdge = getEdge(baseEdge, Self.prevAroundOrg)
        } while edgeDst(currEdge) != firstPoint
        currEdge = getEdge(baseEdge, Self.prevAroundOrg)
        let maxEdges = qedges.count * 4
        for _ in 0..<maxEdges {
            let tempEdge = getEdge(currEdge, Self.prevAroundOrg)
            let tempDst = edgeDst(tempEdge), currOrg = edgeOrg(currEdge), currDst = edgeDst(currEdge)
            if isRightOf(vtx[tempDst].pt, currEdge) > 0
                && Self.isPtInCircle3(vtx[currOrg].pt, vtx[tempDst].pt, vtx[currDst].pt, vtx[currPoint].pt) < 0 {
                swapEdges(currEdge)
                currEdge = getEdge(currEdge, Self.prevAroundOrg)
            } else if currOrg == firstPoint {
                break
            } else {
                currEdge = getEdge(nextEdge(currEdge), Self.prevAroundLeft)
            }
        }
        return currPoint
    }

    /// `getTriangleList`: each triangle as three vertices, skipping any touching the virtual outer
    /// vertices (`Rect2f(topLeft, bottomRight).contains`, half-open).
    func triangleList() -> [[CVGeometry.Point2f]] {
        let total = qedges.count * 4
        var mask = [Bool](repeating: false, count: total)
        let rx = topLeft.x, ry = topLeft.y
        let rw = bottomRight.x - topLeft.x, rh = bottomRight.y - topLeft.y
        func contains(_ p: CVGeometry.Point2f) -> Bool { rx <= p.x && p.x < rx + rw && ry <= p.y && p.y < ry + rh }
        var out: [[CVGeometry.Point2f]] = []
        var i = 4
        while i < total {
            defer { i += 2 }
            if mask[i] { continue }
            let ea = i
            let a = vtx[edgeOrg(ea)].pt
            if !contains(a) { continue }
            let eb = getEdge(ea, Self.nextAroundLeft)
            let b = vtx[edgeOrg(eb)].pt
            if !contains(b) { continue }
            let ec = getEdge(eb, Self.nextAroundLeft)
            let c = vtx[edgeOrg(ec)].pt
            if !contains(c) { continue }
            mask[ea] = true; mask[eb] = true; mask[ec] = true
            out.append([a, b, c])
        }
        return out
    }
}
