// SPDX-License-Identifier: AGPL-3.0-or-later
//
// omr-sheet-cam — homr bounding boxes (page pipeline, milestone 2).
// Port of liebharc/homr @ 7d97c3cee4ad772b50266fdf9dc78bbf9064701e (AGPL-3.0): homr/bounding_boxes.py
// (BoundingBox, AngledBoundingBox, RotatedBoundingBox, BoundingEllipse, create_rotated_bounding_boxes,
// create_bounding_ellipses, merge_overlaying_bounding_boxes) plus numpy's pairwise float64 summation,
// which homr's np.mean / np.std / np.median results depend on.

import Foundation

/// A homr `AngledBoundingBox` (or the axis-aligned `BoundingBox` used for staff points).
/// `cx ... angle` are the normalised `self.box` values as Python doubles; equality and hashing use only
/// them, like homr's `__eq__` / `__hash__` on the box tuple.
struct HBox: Hashable, CustomStringConvertible {
    typealias Point = CVContours.Point
    enum Kind { case rotated, ellipse, axis }

    let cx: Double, cy: Double, w: Double, h: Double, angle: Double
    let kind: Kind
    /// int64 polygon (`boxPoints(...).astype(int64)` or `ellipse2Poly(...)`).
    let polygon: [Point]
    /// `self.contours` (the contour points the box was fitted to).
    let contour: [Point]

    static func == (a: HBox, b: HBox) -> Bool {
        a.cx == b.cx && a.cy == b.cy && a.w == b.w && a.h == b.h && a.angle == b.angle
    }
    func hash(into hasher: inout Hasher) {
        hasher.combine(cx); hasher.combine(cy); hasher.combine(w); hasher.combine(h); hasher.combine(angle)
    }
    var description: String { "((\(cx), \(cy)), (\(w), \(h)), \(angle))" }
    var box: [Double] { [cx, cy, w, h, angle] }

    typealias Raw = (cx: Double, cy: Double, w: Double, h: Double, angle: Double)

    private init(norm: Raw, kind: Kind, polygon: [Point], contour: [Point]) {
        cx = norm.cx; cy = norm.cy; w = norm.w; h = norm.h; angle = norm.angle
        self.kind = kind; self.polygon = polygon; self.contour = contour
    }

    /// AngledBoundingBox.__init__ angle normalisation.
    static func normalize(_ b: Raw) -> Raw {
        if b.angle > 135 { return (b.cx, b.cy, b.w, b.h, b.angle - 180) }
        if b.angle < -135 { return (b.cx, b.cy, b.w, b.h, b.angle + 180) }
        if b.angle > 45 { return (b.cx, b.cy, b.h, b.w, b.angle - 90) }
        if b.angle < -45 { return (b.cx, b.cy, b.h, b.w, b.angle + 90) }
        return b
    }

    static func cvRect(_ b: Raw) -> CVShapes.RotatedRect {
        CVShapes.RotatedRect(cx: Float(b.cx), cy: Float(b.cy), w: Float(b.w), h: Float(b.h), angle: Float(b.angle))
    }

    static func raw(_ r: CVShapes.RotatedRect) -> Raw {
        (Double(r.cx), Double(r.cy), Double(r.w), Double(r.h), Double(r.angle))
    }

    /// RotatedBoundingBox(box, contours).
    static func rotated(_ b: Raw, contour: [Point]) -> HBox {
        HBox(norm: normalize(b), kind: .rotated, polygon: CVShapes.boxPolygon(cvRect(b)), contour: contour)
    }

    /// BoundingEllipse(box, contours).
    static func ellipse(_ b: Raw, contour: [Point]) -> HBox {
        let poly = CVShapes.ellipse2Poly(center: Point(x: Int(b.cx), y: Int(b.cy)),
                                         axes: (Int(b.w / 2), Int(b.h / 2)), angle: Int(b.angle))
        return HBox(norm: normalize(b), kind: .ellipse, polygon: poly, contour: contour)
    }

    /// BoundingBox((x1, y1, x2, y2)): `rotated_box = (center, size, 0)`.
    static func axis(x1: Int, y1: Int, x2: Int, y2: Int) -> HBox {
        let b: Raw = (Double(x1 + x2) / 2, Double(y1 + y2) / 2, Double(x2 - x1), Double(y2 - y1), 0)
        return HBox(norm: b, kind: .axis, polygon: CVShapes.boxPolygon(cvRect(b)), contour: [])
    }

    var raw: Raw { (cx, cy, w, h, angle) }
    var topLeft: (Double, Double) { (cx - w / 2, cy - h / 2) }
    var bottomLeft: (Double, Double) { (cx - w / 2, cy + h / 2) }
    var topRight: (Double, Double) { (cx + w / 2, cy - h / 2) }
    var bottomRight: (Double, Double) { (cx + w / 2, cy + h / 2) }

    // MARK: geometry predicates

    func canPossiblyTouch(_ o: HBox) -> Bool {
        let dx = cx - o.cx, dy = cy - o.cy
        let distance = (dx * dx + dy * dy).squareRoot()
        return !(distance > max(w, h) + max(o.w, o.h))
    }

    /// AngledBoundingBox.is_overlapping (do_polygons_overlap).
    func isOverlapping(_ o: HBox) -> Bool {
        if !canPossiblyTouch(o) { return false }
        if CVShapes.intersectConvexConvexArea(polygon, o.polygon) > 0 { return true }
        for p in polygon where CVShapes.pointPolygonTest(o.polygon, p) >= 0 { return true }
        for p in o.polygon where CVShapes.pointPolygonTest(polygon, p) >= 0 { return true }
        return false
    }

    func isOverlappingWithAny(_ others: [HBox]) -> Bool {
        others.contains { isOverlapping($0) }
    }

    /// RotatedBoundingBox.is_intersecting (rotatedRectangleIntersection != INTERSECT_NONE).
    func isIntersecting(_ o: HBox) -> Bool {
        if !canPossiblyTouch(o) { return false }
        return CVShapes.rotatedRectsIntersect(HBox.cvRect(raw), HBox.cvRect(o.raw))
    }

    func makeThicker(_ t: Double) -> HBox {
        switch kind {
        case .ellipse: return .ellipse((cx, cy, w + t, h + t, angle), contour: contour)
        default:
            if t <= 0 { return self }
            return .rotated((cx, cy, w + t, h + t, angle), contour: contour)
        }
    }

    func makeTaller(_ t: Double) -> HBox { .rotated((cx, cy, w, h + t, angle), contour: contour) }
    func moveX(_ d: Double) -> HBox { .rotated((cx + d, cy, w, h, angle), contour: contour) }

    func centerExtrapolated(_ x: Double) -> Double {
        (x - cx) * tan(angle / 180 * Double.pi) + cy
    }

    /// RotatedBoundingBox.is_overlapping_extrapolated.
    func isOverlappingExtrapolated(_ other: HBox, unitSize: Double) -> Bool {
        let (l, r) = cx > other.cx ? (other, self) : (self, other)
        let centerX = (l.cx + r.cx) * 0.5
        let tolerance = unitSize / 3
        let maxGap = 5 * unitSize
        let gapL: Double = centerX - l.cx - (l.w / 2).rounded(.down)
        let gapR: Double = r.cx - centerX - (r.w / 2).rounded(.down)
        if gapL > maxGap || gapR > maxGap { return false }
        let la = tan(l.angle * Double.pi / 180.0), ra = tan(r.angle * Double.pi / 180.0)
        let ly = (centerX - l.cx) * la + l.cy
        let ry = (centerX - r.cx) * ra + r.cy
        return abs(ly - ry) <= tolerance
    }
}

enum HomrBoxes {
    typealias Point = CVContours.Point

    private static func validSize(_ r: CVShapes.RotatedRect) -> Bool {
        !r.w.isNaN && !r.h.isNaN && r.w > 0 && r.h > 0
    }

    /// create_rotated_bounding_boxes(img, skip_merging, min_size, max_size).
    static func rotatedBoxes(_ img: [UInt8], width: Int, height: Int, skipMerging: Bool = false,
                             minSize: (Double, Double)? = nil, maxSize: (Double, Double)? = nil) -> [HBox] {
        let contours = img.withUnsafeBufferPointer {
            CVContours.find($0, width: width, height: height, mode: .tree)
        }
        var boxes: [HBox] = []
        for c in contours {
            let fit = CVShapes.minAreaRect(c)
            if !validSize(fit) { continue }
            let b = HBox.rotated(HBox.raw(fit), contour: c)
            if let m = minSize, b.w < m.0 || b.h < m.1 { continue }
            if let m = maxSize {
                if m.0 > 0 && b.w > m.0 { continue }
                if m.1 > 0 && b.h > m.1 { continue }
            }
            boxes.append(b)
        }
        if skipMerging { return boxes }
        return mergeOverlapping(boxes).map { group in
            let all = group.flatMap { $0.contour }
            return HBox.rotated(HBox.raw(CVShapes.minAreaRect(all)), contour: all)
        }
    }

    /// create_bounding_ellipses(img, min_size=...).
    static func ellipses(_ img: [UInt8], width: Int, height: Int, minSize: (Double, Double)?,
                         rng: inout CVShapes.RNG) -> [HBox] {
        let contours = img.withUnsafeBufferPointer {
            CVContours.find($0, width: width, height: height, mode: .tree)
        }
        var boxes: [HBox] = []
        for c in contours where c.count >= 5 {
            let fit = CVShapes.fitEllipse(c, rng: &rng)
            if !validSize(fit) { continue }
            let b = HBox.ellipse(HBox.raw(fit), contour: c)
            if let m = minSize, b.w < m.0 || b.h < m.1 { continue }
            boxes.append(b)
        }
        return mergeOverlapping(boxes).map { group in
            let all = group.flatMap { $0.contour }
            return HBox.ellipse(HBox.raw(CVShapes.minAreaRect(all)), contour: all)
        }
    }

    /// merge_overlaying_bounding_boxes (union-find, groups in order of their first member).
    static func mergeOverlapping(_ boxes: [HBox]) -> [[HBox]] {
        let n = boxes.count
        var parent = Array(0..<n)
        var rank = [Int](repeating: 0, count: n)
        func find(_ x: Int) -> Int {
            var r = x
            while parent[r] != r { r = parent[r] }
            var y = x
            while parent[y] != r { let nx = parent[y]; parent[y] = r; y = nx }
            return r
        }
        for i in 0..<n {
            for j in (i + 1)..<max(i + 1, n) where boxes[i].isOverlapping(boxes[j]) {
                let ri = find(i), rj = find(j)
                if ri == rj { continue }
                if rank[ri] > rank[rj] { parent[rj] = ri } else if rank[ri] < rank[rj] { parent[ri] = rj } else {
                    parent[rj] = ri; rank[ri] += 1
                }
            }
        }
        var order: [Int] = []
        var groups: [Int: [HBox]] = [:]
        for i in 0..<n {
            let r = find(i)
            if groups[r] == nil { order.append(r); groups[r] = [] }
            groups[r]!.append(boxes[i])
        }
        return order.map { groups[$0]! }
    }
}

/// numpy float64 reductions in numpy's own summation order (pairwise, 8-way unrolled blocks of 128).
enum NP {
    static func sum(_ a: ArraySlice<Double>) -> Double {
        let n = a.count
        let s = a.startIndex
        if n < 8 {
            var r = 0.0
            for v in a { r += v }
            return r
        }
        if n <= 128 {
            var r = [Double](a[s..<(s + 8)])
            var i = 8
            while i < n - (n % 8) {
                for j in 0..<8 { r[j] += a[s + i + j] }
                i += 8
            }
            let lo: Double = (r[0] + r[1]) + (r[2] + r[3])
            let hi: Double = (r[4] + r[5]) + (r[6] + r[7])
            var res = lo + hi
            while i < n { res += a[s + i]; i += 1 }
            return res
        }
        var n2 = n / 2
        n2 -= n2 % 8
        return sum(a[s..<(s + n2)]) + sum(a[(s + n2)...])
    }
    static func sum(_ a: [Double]) -> Double { sum(a[...]) }
    static func mean(_ a: [Double]) -> Double { sum(a) / Double(a.count) }
    static func std(_ a: [Double]) -> Double {
        let m = mean(a)
        let sq = a.map { ($0 - m) * ($0 - m) }
        return (sum(sq) / Double(a.count)).squareRoot()
    }
    static func median(_ a: [Double]) -> Double {
        let s = a.sorted()
        let n = s.count
        if n % 2 == 1 { return s[n / 2] }
        return (s[n / 2 - 1] + s[n / 2]) / 2
    }
    static func diff(_ a: [Double]) -> [Double] {
        if a.count < 2 { return [] }
        var out: [Double] = []
        out.reserveCapacity(a.count - 1)
        for i in 1..<a.count {
            let d: Double = a[i] - a[i - 1]
            out.append(d)
        }
        return out
    }
    /// Python round() (half to even) -> int.
    static func round(_ v: Double) -> Int { Int(v.rounded(.toNearestOrEven)) }
}
