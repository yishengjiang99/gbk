// SPDX-License-Identifier: AGPL-3.0-or-later
//
// omr-sheet-cam — OpenCV 5.0.0 shape primitives used by homr's staff detection.
// Port of liebharc/homr @ 7d97c3cee4ad772b50266fdf9dc78bbf9064701e (AGPL-3.0): the cv2 calls made by
// homr/bounding_boxes.py, staff_detection.py and brace_dot_detection.py, re-implemented after OpenCV
// 5.0.0 (Apache-2.0): convexHull (Sklansky), minAreaRect (rotating calipers, float32), RotatedRect::points
// (boxPoints), intersectConvexConvex (O'Rourke), pointPolygonTest (integer branch),
// rotatedRectangleIntersection (emptiness only), fitEllipse (Direct for n == 5, NoDirect otherwise),
// ellipse2Poly, fillPoly/drawContours(FILLED, LINE_8) and MORPH_ELLIPSE erode/dilate on 0/1 masks.
// All float32 arithmetic is kept in Float, in OpenCV's evaluation order, so results match bit for bit
// (fitEllipse's SVD/eigen solves are the documented exception: Householder QR / closed-form 3x3 eigen).

import Foundation

enum CVShapes {
    typealias Point = CVContours.Point

    struct Point2f: Equatable {
        var x: Float
        var y: Float
        init(_ x: Float, _ y: Float) { self.x = x; self.y = y }
    }

    /// cv::RotatedRect (float32 fields).
    struct RotatedRect: Equatable {
        var cx: Float = 0, cy: Float = 0, w: Float = 0, h: Float = 0, angle: Float = 0
    }

    // MARK: - convexHull (int points, clockwise = false, returnPoints = true)

    private static func sign(_ v: Int) -> Int { v > 0 ? 1 : (v < 0 ? -1 : 0) }

    /// `Sklansky_<int, int64>` over the sorted point array (indices into `a`).
    private static func sklansky(_ a: [Point], _ start: Int, _ endIn: Int, _ stack: inout [Int],
                                 _ nsign: Int, _ sign2: Int) -> Int {
        let incr = endIn > start ? 1 : -1
        var pprev = start, pcur = pprev + incr, pnext = pcur + incr
        var stacksize = 3
        if start == endIn || (a[start].x == a[endIn].x && a[start].y == a[endIn].y) {
            stack[0] = start
            return 1
        }
        stack[0] = pprev; stack[1] = pcur; stack[2] = pnext
        let end = endIn + incr
        while pnext != end {
            let cury = a[pcur].y, nexty = a[pnext].y
            let by = nexty - cury
            if sign(by) != nsign {
                let a0 = a[pcur].x - a[pprev].x, a1 = cury - a[pprev].y
                let b0 = a[pnext].x - a[pcur].x, b1 = by
                let convexity = a1 * b0 - a0 * b1
                if sign(convexity) == sign2 && (a0 != 0 || a1 != 0) {
                    pprev = pcur; pcur = pnext; pnext += incr
                    stack[stacksize] = pnext
                    stacksize += 1
                } else if pprev == start {
                    pcur = pnext; stack[1] = pcur
                    pnext += incr; stack[2] = pnext
                } else {
                    stack[stacksize - 2] = pnext
                    pcur = pprev
                    pprev = stack[stacksize - 4]
                    stacksize -= 1
                }
            } else {
                pnext += incr
                stack[stacksize - 1] = pnext
            }
        }
        stacksize -= 1
        return stacksize
    }

    /// cv::convexHull(points, clockwise=false, returnPoints=true) for CV_32S input.
    static func convexHull(_ pts: [Point]) -> [Point] {
        let total = pts.count
        if total == 0 { return [] }
        let order = (0..<total).sorted { i, j in
            let p = pts[i], q = pts[j]
            if p.x != q.x { return p.x < q.x }
            if p.y != q.y { return p.y < q.y }
            return i < j
        }
        let sp = order.map { pts[$0] }
        var minyInd = 0, maxyInd = 0
        for i in 1..<max(total, 1) where total > 1 {
            let y = sp[i].y
            if sp[minyInd].y > y { minyInd = i }
            if sp[maxyInd].y < y { maxyInd = i }
        }
        var hull: [Int] = []
        if sp[0].x == sp[total - 1].x && sp[0].y == sp[total - 1].y {
            return [pts[0]]
        }
        var s1 = [Int](repeating: 0, count: total + 2)
        var s2 = [Int](repeating: 0, count: total + 2)
        // upper half (clockwise == false: tl/tr swapped)
        let tlCount0 = sklansky(sp, 0, maxyInd, &s1, -1, 1)
        let trCount0 = sklansky(sp, total - 1, maxyInd, &s2, -1, -1)
        let tl = s2, tlCount = trCount0, tr = s1, trCount = tlCount0
        if tlCount > 1 { for i in 0..<(tlCount - 1) { hull.append(tl[i]) } }
        if trCount > 1 { for i in stride(from: trCount - 1, to: 0, by: -1) { hull.append(tr[i]) } }
        let stopIdx = trCount > 2 ? tr[1] : (tlCount > 2 ? tl[tlCount - 2] : -1)
        // lower half
        var bl = [Int](repeating: 0, count: total + 2)
        var br = [Int](repeating: 0, count: total + 2)
        var blCount = sklansky(sp, 0, minyInd, &bl, 1, -1)
        var brCount = sklansky(sp, total - 1, minyInd, &br, 1, 1)
        if stopIdx >= 0 {
            let checkIdx = blCount > 2 ? bl[1] : (blCount + brCount > 2 ? br[2 - blCount] : -1)
            if checkIdx == stopIdx || (checkIdx >= 0 && sp[checkIdx] == sp[stopIdx]) {
                blCount = min(blCount, 2)
                brCount = min(brCount, 2)
            }
        }
        if blCount > 1 { for i in 0..<(blCount - 1) { hull.append(bl[i]) } }
        if brCount > 1 { for i in stride(from: brCount - 1, to: 0, by: -1) { hull.append(br[i]) } }
        var hb = hull.map { order[$0] }
        let nout = hb.count
        if nout >= 3 {
            var minIdx = 0, maxIdx = 0, lt = 0
            var i = 1
            while i < nout {
                let idx = hb[i]
                lt += hb[i - 1] < idx ? 1 : 0
                if lt > 1 && lt <= i - 2 { break }
                if idx < hb[minIdx] { minIdx = i }
                if idx > hb[maxIdx] { maxIdx = i }
                i += 1
            }
            let mmdist = abs(maxIdx - minIdx)
            if (mmdist == 1 || mmdist == nout - 1) && (lt <= 1 || lt >= nout - 2) {
                let ascending = (maxIdx + 1) % nout == minIdx
                let i0 = ascending ? minIdx : maxIdx
                var j = i0
                if i0 > 0 {
                    var tmp = [Int](repeating: 0, count: nout)
                    var k = 0
                    while k < nout {
                        let curr = hb[j]
                        tmp[k] = curr
                        let nextJ = j + 1 < nout ? j + 1 : 0
                        let next = hb[nextJ]
                        if k < nout - 1 && (ascending != (curr < next)) { break }
                        j = nextJ
                        k += 1
                    }
                    if k == nout { hb = tmp }
                }
            }
        }
        return hb.map { pts[$0] }
    }

    // MARK: - minAreaRect

    private static func rot90CW(_ p: Point2f) -> Point2f { Point2f(p.y, -p.x) }
    private static func rot90CCW(_ p: Point2f) -> Point2f { Point2f(-p.y, p.x) }
    private static func rot180(_ p: Point2f) -> Point2f { Point2f(-p.x, -p.y) }
    private static func firstVecIsRight(_ v1: Point2f, _ v2: Point2f) -> Bool {
        let t = rot90CW(v1)
        let d0: Float = t.x * v2.x
        let d1: Float = t.y * v2.y
        return d0 + d1 < 0
    }

    private struct CaliperBest {
        var left = 0, bottom = 0
        var baseA: Float = 0, baseB: Float = 0, width: Float = 0, height: Float = 0
    }

    /// rotatingCalipers(..., orientation = 1, CALIPERS_MINAREARECT): returns out[0..5].
    private static func rotatingCalipers(_ p: [Point2f]) -> [Float] {
        let n = p.count
        var vect = [Point2f](repeating: Point2f(0, 0), count: n)
        var invLen = [Float](repeating: 0, count: n)
        var left = 0, bottom = 0, right = 0, top = 0
        var pt0 = p[0]
        var leftX = pt0.x, rightX = pt0.x, topY = pt0.y, bottomY = pt0.y
        for i in 0..<n {
            if pt0.x < leftX { leftX = pt0.x; left = i }
            if pt0.x > rightX { rightX = pt0.x; right = i }
            if pt0.y > topY { topY = pt0.y; top = i }
            if pt0.y < bottomY { bottomY = pt0.y; bottom = i }
            let pt = p[i + 1 < n ? i + 1 : 0]
            let dxf: Float = pt.x - pt0.x
            let dyf: Float = pt.y - pt0.y
            let dx = Double(dxf), dy = Double(dyf)
            vect[i] = Point2f(dxf, dyf)
            invLen[i] = Float(1.0 / (dx * dx + dy * dy).squareRoot())
            pt0 = pt
        }
        var baseA: Float = 1, baseB: Float = 0
        var seq = [bottom, right, top, left]
        var minarea = Float.greatestFiniteMagnitude
        var best = CaliperBest()
        for _ in 0..<n {
            var main = 0
            let rv = [vect[seq[0]], rot90CW(vect[seq[1]]), rot180(vect[seq[2]]), rot90CCW(vect[seq[3]])]
            for i in 1..<4 where firstVecIsRight(rv[i], rv[main]) { main = i }
            let pi = seq[main]
            let leadX: Float = vect[pi].x * invLen[pi]
            let leadY: Float = vect[pi].y * invLen[pi]
            switch main {
            case 0: baseA = leadX; baseB = leadY
            case 1: baseA = leadY; baseB = -leadX
            case 2: baseA = -leadX; baseB = -leadY
            default: baseA = -leadY; baseB = leadX
            }
            seq[main] += 1
            if seq[main] == n { seq[main] = 0 }
            var dx: Float = p[seq[1]].x - p[seq[3]].x
            var dy: Float = p[seq[1]].y - p[seq[3]].y
            let wa: Float = dx * baseA
            let wb: Float = dy * baseB
            let width: Float = wa + wb
            dx = p[seq[2]].x - p[seq[0]].x
            dy = p[seq[2]].y - p[seq[0]].y
            let ha: Float = -dx * baseB
            let hb: Float = dy * baseA
            let height: Float = ha + hb
            let area: Float = width * height
            if area <= minarea {
                minarea = area
                best = CaliperBest(left: seq[3], bottom: seq[0], baseA: baseA, baseB: baseB,
                                   width: width, height: height)
            }
        }
        let a1 = best.baseA, b1 = best.baseB
        let a2 = -best.baseB, b2 = best.baseA
        let pl = p[best.left], pb = p[best.bottom]
        let c1: Float = a1 * pl.x + pl.y * b1
        let c2: Float = a2 * pb.x + pb.y * b2
        let det: Float = a1 * b2 - a2 * b1
        let idet: Float = 1 / det
        let pxn: Float = c1 * b2 - c2 * b1
        let pyn: Float = a1 * c2 - a2 * c1
        return [pxn * idet, pyn * idet, a1 * best.width, b1 * best.width, a2 * best.height, b2 * best.height]
    }

    /// cv::minAreaRect for integer points (angle in [-90, 0)).
    static func minAreaRect(_ pts: [Point]) -> RotatedRect {
        let hull = convexHull(pts)
        let hp = hull.map { Point2f(Float($0.x), Float($0.y)) }
        var box = RotatedRect()
        var angle = -Double.pi / 2
        let n = hp.count
        if n > 2 {
            let o = rotatingCalipers(hp)
            let sx: Float = o[2] + o[4]
            let sy: Float = o[3] + o[5]
            box.cx = o[0] + sx * 0.5
            box.cy = o[1] + sy * 0.5
            let w2: Double = Double(o[4]) * Double(o[4]) + Double(o[5]) * Double(o[5])
            let h2: Double = Double(o[2]) * Double(o[2]) + Double(o[3]) * Double(o[3])
            box.w = Float(w2.squareRoot())
            box.h = Float(h2.squareRoot())
            if o[2] == 0 && o[3] > 0 {
                swap(&box.w, &box.h)
            } else {
                angle = -atan2(Double(o[2]), Double(o[3]))
            }
        } else if n == 2 {
            let sx: Float = hp[0].x + hp[1].x
            let sy: Float = hp[0].y + hp[1].y
            box.cx = sx * 0.5
            box.cy = sy * 0.5
            let dx = Double(hp[0].x - hp[1].x)
            let dy = Double(hp[0].y - hp[1].y)
            box.w = 0
            box.h = Float((dx * dx + dy * dy).squareRoot())
            if dx == 0 {
                swap(&box.w, &box.h)
            } else if dy < 0 {
                angle = atan2(dy, dx)
                swap(&box.w, &box.h)
            } else if dy > 0 {
                angle = -atan2(dx, dy)
            }
        } else if n == 1 {
            box.cx = hp[0].x; box.cy = hp[0].y
        }
        box.angle = Float(angle * 180 / Double.pi)
        return box
    }

    // MARK: - RotatedRect::points (cv2.boxPoints)

    static func boxPoints(_ r: RotatedRect) -> [Point2f] {
        let rad: Double = Double(r.angle) * Double.pi / 180.0
        let b: Float = Float(cos(rad)) * 0.5
        let a: Float = Float(sin(rad)) * 0.5
        let ah: Float = a * r.h, aw: Float = a * r.w
        let bh: Float = b * r.h, bw: Float = b * r.w
        let x0: Float = r.cx - ah - bw, y0: Float = r.cy + bh - aw
        let x1: Float = r.cx + ah - bw, y1: Float = r.cy - bh - aw
        let x2: Float = r.cx + ah + bw, y2: Float = r.cy - bh + aw
        let x3: Float = r.cx - ah + bw, y3: Float = r.cy + bh + aw
        return [Point2f(x0, y0), Point2f(x1, y1), Point2f(x2, y2), Point2f(x3, y3)]
    }

    /// `cv2.boxPoints(box).astype(np.int64)` (truncation toward zero).
    static func boxPolygon(_ r: RotatedRect) -> [Point] {
        boxPoints(r).map { Point(x: Int($0.x), y: Int($0.y)) }
    }

    // MARK: - pointPolygonTest (integer branch, measureDist = false)

    static func pointPolygonTest(_ cnt: [Point], _ ip: Point) -> Int {
        let total = cnt.count
        if total == 0 { return -1 }
        var counter = 0
        var v = cnt[total - 1]
        for i in 0..<total {
            let v0 = v
            v = cnt[i]
            if (v0.y <= ip.y && v.y <= ip.y) || (v0.y > ip.y && v.y > ip.y) || (v0.x < ip.x && v.x < ip.x) {
                if ip.y == v.y && (ip.x == v.x || (ip.y == v0.y &&
                    ((v0.x <= ip.x && ip.x <= v.x) || (v.x <= ip.x && ip.x <= v0.x)))) {
                    return 0
                }
                continue
            }
            var dist = (ip.y - v0.y) * (v.x - v0.x) - (ip.x - v0.x) * (v.y - v0.y)
            if dist == 0 { return 0 }
            if v.y < v0.y { dist = -dist }
            counter += dist > 0 ? 1 : 0
        }
        return counter % 2 == 0 ? -1 : 1
    }

    /// Float-contour branch with a float point (used by intersectConvexConvex's nested check).
    private static func pointPolygonTestF(_ cnt: [Point2f], _ pt: Point2f) -> Int {
        let total = cnt.count
        if total == 0 { return -1 }
        var counter = 0
        var v = cnt[total - 1]
        for i in 0..<total {
            let v0 = v
            v = cnt[i]
            if (v0.y <= pt.y && v.y <= pt.y) || (v0.y > pt.y && v.y > pt.y) || (v0.x < pt.x && v.x < pt.x) {
                if pt.y == v.y && (pt.x == v.x || (pt.y == v0.y &&
                    ((v0.x <= pt.x && pt.x <= v.x) || (v.x <= pt.x && pt.x <= v0.x)))) {
                    return 0
                }
                continue
            }
            let t0: Double = Double(pt.y - v0.y) * Double(v.x - v0.x)
            let t1: Double = Double(pt.x - v0.x) * Double(v.y - v0.y)
            var dist = t0 - t1
            if dist == 0 { return 0 }
            if v.y < v0.y { dist = -dist }
            counter += dist > 0 ? 1 : 0
        }
        return counter % 2 == 0 ? -1 : 1
    }

    // MARK: - intersectConvexConvex (area only, handleNested = true)

    private enum InFlag { case pin, qin, unknown }
    private enum LSI { case none, single, overlap, endpoint }

    private static func areaSign(_ a: Point2f, _ b: Point2f, _ c: Point2f) -> Int {
        let t0: Double = Double(b.x - a.x) * Double(c.y - a.y)
        let t1: Double = Double(c.x - a.x) * Double(b.y - a.y)
        let area2 = t0 - t1
        return area2 > 1e-5 ? 1 : (area2 < -1e-5 ? -1 : 0)
    }

    private static func between(_ a: Point2f, _ b: Point2f, _ c: Point2f) -> Bool {
        if a.x != b.x {
            return (a.x <= c.x && c.x <= b.x) || (a.x >= c.x && c.x >= b.x)
        }
        return (a.y <= c.y && c.y <= b.y) || (a.y >= c.y && c.y >= b.y)
    }

    private static func parallelInt(_ a: Point2f, _ b: Point2f, _ c: Point2f, _ d: Point2f,
                                    _ p: inout Point2f, _ q: inout Point2f) -> LSI {
        if areaSign(a, b, c) != 0 { return .none }
        if between(a, b, c) && between(a, b, d) { p = c; q = d; return .overlap }
        if between(c, d, a) && between(c, d, b) { p = a; q = b; return .overlap }
        if between(a, b, c) && between(c, d, b) { p = c; q = b; return .overlap }
        if between(a, b, c) && between(c, d, a) { p = c; q = a; return .overlap }
        if between(a, b, d) && between(c, d, b) { p = d; q = b; return .overlap }
        if between(a, b, d) && between(c, d, a) { p = d; q = a; return .overlap }
        return .none
    }

    private static func intersectSegments(_ a: Point2f, _ b: Point2f, _ c: Point2f, _ d: Point2f,
                                          _ p: inout Point2f, _ q: inout Point2f) -> LSI {
        let ax = Double(a.x), ay = Double(a.y), bx = Double(b.x), by = Double(b.y)
        let cx = Double(c.x), cy = Double(c.y), dx = Double(d.x), dy = Double(d.y)
        let dn0: Double = (ax - bx) * (dy - cy)
        let dn1: Double = (ay - by) * (dx - cx)
        let denom = dn0 - dn1
        if denom == 0 { return parallelInt(a, b, c, d, &p, &q) }
        let n0: Double = (dy - ay) * (ax - cx)
        let n1: Double = (ax - dx) * (ay - cy)
        let s = (n0 + n1) / denom
        let m0: Double = (by - ay) * (ax - cx)
        let m1: Double = (cy - ay) * (bx - ax)
        let t = (m0 + m1) / denom
        p = Point2f(Float(ax + s * (bx - ax)), Float(ay + s * (by - ay)))
        q = p
        if s < 0 || s > 1 || t < 0 || t > 1 { return .none }
        if s == 0 || s == 1 || t == 0 || t == 1 { return .endpoint }
        return .single
    }

    /// Returns the (signed, float) area of `intersectConvexConvex_` or nil if it did not converge.
    private static func convexConvexCore(_ P: [Point2f], _ Q: [Point2f]) -> (area: Float, count: Int)? {
        let n = P.count, m = Q.count
        let resultSize = n + m + 1
        var res: [Point2f] = [Point2f(Float.greatestFiniteMagnitude, Float.greatestFiniteMagnitude)]
        var a = 0, b = 0, aa = 0, ba = 0
        var inflag = InFlag.unknown
        var firstPoint = true
        func push(_ p: Point2f) { if p != res[res.count - 1] { res.append(p) } }
        repeat {
            let a1 = (a + n - 1) % n, b1 = (b + m - 1) % m
            let A = Point2f(P[a].x - P[a1].x, P[a].y - P[a1].y)
            let B = Point2f(Q[b].x - Q[b1].x, Q[b].y - Q[b1].y)
            let cross = areaSign(Point2f(0, 0), A, B)
            let aHB = areaSign(Q[b1], Q[b], P[a])
            let bHA = areaSign(P[a1], P[a], Q[b])
            var p = Point2f(0, 0), q = Point2f(0, 0)
            let code = intersectSegments(P[a1], P[a], Q[b1], Q[b], &p, &q)
            if code == .single || code == .endpoint {
                if inflag == .unknown && firstPoint {
                    aa = 0; ba = 0
                    firstPoint = false
                    res.append(p)
                }
                push(p)
                inflag = aHB > 0 ? .pin : (bHA > 0 ? .qin : inflag)
            }
            let dotAB: Double = Double(A.x) * Double(B.x) + Double(A.y) * Double(B.y)
            if code == .overlap && dotAB < 0 {
                push(p); push(q)
                // OpenCV returns the raw count here without computing the area (it stays 0)
                return (0, res.count)
            }
            if cross == 0 && aHB < 0 && bHA < 0 {
                return (0, res.count)
            } else if cross == 0 && aHB == 0 && bHA == 0 {
                if inflag == .pin {
                    if inflag == .qin { push(Q[b]) }
                    ba += 1; b = (b + 1) % m
                } else {
                    if inflag == .pin { push(P[a]) }
                    aa += 1; a = (a + 1) % n
                }
            } else if cross >= 0 {
                if bHA > 0 {
                    if inflag == .pin { push(P[a]) }
                    aa += 1; a = (a + 1) % n
                } else {
                    if inflag == .qin { push(Q[b]) }
                    ba += 1; b = (b + 1) % m
                }
            } else {
                if aHB > 0 {
                    if inflag == .qin { push(Q[b]) }
                    ba += 1; b = (b + 1) % m
                } else {
                    if inflag == .pin { push(P[a]) }
                    aa += 1; a = (a + 1) % n
                }
            }
        } while ((aa < n) || (ba < m)) && (aa < 2 * n) && (ba < 2 * m) && (res.count <= resultSize)
        return finishArea(res, resultSize)
    }

    private static func finishArea(_ r: [Point2f], _ resultSize: Int) -> (area: Float, count: Int)? {
        var res = r
        var nr = res.count
        if nr > resultSize { return nil }
        var area = 0.0
        var prev = res[nr - 1]
        if nr > 1 {
            for i in 1..<nr {
                res[i - 1] = res[i]
                let t0: Double = Double(prev.x) * Double(res[i].y)
                let t1: Double = Double(prev.y) * Double(res[i].x)
                area += t0 - t1
                prev = res[i]
            }
        }
        let a = Float(area * 0.5)
        if nr > 1 && res[nr - 2] == res[0] { nr -= 1 }
        return (a, nr - 1)
    }

    private static func orient(_ pts: [Point2f]) -> [Point2f] {
        let len = pts.count
        let d0 = Point2f(pts[0].x - pts[len - 1].x, pts[0].y - pts[len - 1].y)
        for i in 1..<len {
            let dx: Float = pts[i].x - pts[i - 1].x
            let dy: Float = pts[i].y - pts[i - 1].y
            let s: Double = Double(d0.x) * Double(dy) - Double(d0.y) * Double(dx)
            if s != 0 {
                return s < 0 ? Array(pts.reversed()) : pts
            }
        }
        return pts
    }

    private static func contourAreaF(_ pts: [Point2f]) -> Double {
        guard let last = pts.last else { return 0 }
        var a00 = 0.0
        var prev = last
        for p in pts {
            let t0: Double = Double(prev.x) * Double(p.y)
            let t1: Double = Double(prev.y) * Double(p.x)
            a00 += t0 - t1
            prev = p
        }
        return abs(a00 * 0.5)
    }

    /// `cv2.intersectConvexConvex(p1.astype(float32), p2.astype(float32))[0]` for integer polygons.
    static func intersectConvexConvexArea(_ p1: [Point], _ p2: [Point]) -> Float {
        if p1.count < 2 || p2.count < 2 { return 0 }
        let fp1 = orient(p1.map { Point2f(Float($0.x), Float($0.y)) })
        let fp2 = orient(p2.map { Point2f(Float($0.x), Float($0.y)) })
        guard let core = convexConvexCore(fp1, fp2) else { return -1 }
        var area = core.area
        if core.count == 0 {
            if fp2.allSatisfy({ pointPolygonTestF(fp1, $0) >= 0 }) {
                area = Float(contourAreaF(fp2))
            } else if fp1.allSatisfy({ pointPolygonTestF(fp2, $0) >= 0 }) {
                area = Float(contourAreaF(fp1))
            } else {
                return 0
            }
        }
        return abs(area)
    }

    // MARK: - rotatedRectangleIntersection (!= INTERSECT_NONE)

    private static func onPositiveSide(_ v: Point2f, _ lp: Point2f, _ pt: Point2f) -> Bool {
        let l: Float = v.y * (lp.x - pt.x)
        let r: Float = v.x * (lp.y - pt.y)
        return l >= r
    }

    static func rotatedRectsIntersect(_ r1: RotatedRect, _ r2: RotatedRect) -> Bool {
        if r1.w <= 0 || r1.h <= 0 || r2.w <= 0 || r2.h <= 0 { return false }
        let sx: Float = r1.cx + r2.cx
        let sy: Float = r1.cy + r2.cy
        let avx: Float = sx / 2, avy: Float = sy / 2
        var s1 = r1, s2 = r2
        s1.cx -= avx; s1.cy -= avy
        s2.cx -= avx; s2.cy -= avy
        let p1 = boxPoints(s1), p2 = boxPoints(s2)
        let area1: Float = s1.w * s1.h
        let area2: Float = s2.w * s2.h
        let eps: Float = 1e-6 * max(area1, area2)
        var same = true
        for i in 0..<4 where abs(p1[i].x - p2[i].x) > eps || abs(p1[i].y - p2[i].y) > eps {
            same = false
            break
        }
        if same { return true }
        var v1 = [Point2f](), v2 = [Point2f]()
        for i in 0..<4 {
            v1.append(Point2f(p1[(i + 1) % 4].x - p1[i].x, p1[(i + 1) % 4].y - p1[i].y))
            v2.append(Point2f(p2[(i + 1) % 4].x - p2[i].x, p2[(i + 1) % 4].y - p2[i].y))
        }
        for i in 0..<4 {
            for j in 0..<4 {
                let x21: Float = p2[j].x - p1[i].x
                let y21: Float = p2[j].y - p1[i].y
                let vx1 = v1[i].x, vy1 = v1[i].y, vx2 = v2[j].x, vy2 = v2[j].y
                let d0: Float = vx2 * vy1
                let d1: Float = vx1 * vy2
                let det: Float = d0 - d1
                if Double(abs(det)) < 1e-12 { continue }
                let inv: Float = 1 / det
                let t1a: Float = vx2 * y21
                let t1b: Float = vy2 * x21
                let t1: Float = (t1a - t1b) * inv
                let t2a: Float = vx1 * y21
                let t2b: Float = vy1 * x21
                let t2: Float = (t2a - t2b) * inv
                if t1.isInfinite || t2.isInfinite || t1.isNaN || t2.isNaN { continue }
                if t1 >= 0 && t1 <= 1 && t2 >= 0 && t2 <= 1 { return true }
            }
        }
        for i in 0..<4 {
            var pos = 0
            for j in 0..<4 where onPositiveSide(v2[j], p2[j], p1[i]) { pos += 1 }
            if pos == 4 || pos == 0 { return true }
        }
        for i in 0..<4 {
            var pos = 0
            for j in 0..<4 where onPositiveSide(v1[j], p1[j], p2[i]) { pos += 1 }
            if pos == 4 || pos == 0 { return true }
        }
        return false
    }

    // MARK: - ellipse2Poly (integer overload, delta = 1, full arc)

    static func ellipse2Poly(center: Point, axes: (Int, Int), angle angleIn: Int) -> [Point] {
        var angle = angleIn
        while angle < 0 { angle += 360 }
        while angle > 360 { angle -= 360 }
        let ang = angle < 0 ? angle + 360 : angle
        let alpha = Double(sinTable[450 - ang])   // cos
        let beta = Double(sinTable[ang])          // sin
        var pts: [Point] = []
        var prev = Point(x: Int.min, y: Int.min)
        let cx = Double(center.x), cy = Double(center.y)
        let aw = Double(axes.0), ah = Double(axes.1)
        for i in 0...360 {
            let x: Double = aw * Double(sinTable[450 - i])
            let y: Double = ah * Double(sinTable[i])
            let px: Double = cx + x * alpha - y * beta
            let py: Double = cy + x * beta + y * alpha
            let pt = Point(x: cvRound(px), y: cvRound(py))
            if pt != prev { pts.append(pt); prev = pt }
        }
        if pts.count == 1 { return [center, center] }
        return pts
    }

    /// cvRound: round half to even (lrint under the default rounding mode).
    static func cvRound(_ v: Double) -> Int { Int(v.rounded(.toNearestOrEven)) }

    // MARK: - drawContours(FILLED) row widths (brace core span)

    /// `(mask > 0).sum(axis=1)` after `cv2.drawContours(zeros(h, w), [contour - (x, y)], -1, 255, FILLED)`
    /// where the contour is already shifted into the `w x h` mask.
    static func filledRowWidths(_ c: [Point], width w: Int, height h: Int) -> [Int] {
        var mask = [UInt8](repeating: 0, count: w * h)
        fillPoly(&mask, width: w, height: h, c)
        var rows = [Int](repeating: 0, count: h)
        for y in 0..<h {
            var n = 0
            for x in 0..<w where mask[y * w + x] != 0 { n += 1 }
            rows[y] = n
        }
        return rows
    }

    private static func line8(_ img: inout [UInt8], _ w: Int, _ h: Int, _ p1: Point, _ p2: Point) {
        // LineIterator(img, p1, p2, 8, leftToRight = true); callers keep points inside the image.
        guard p1.x >= 0, p1.x < w, p2.x >= 0, p2.x < w, p1.y >= 0, p1.y < h, p2.y >= 0, p2.y < h else { return }
        var pt1 = p1
        var dx = p2.x - p1.x, dy = p2.y - p1.y
        var sx = 1, sy = 1
        if dx < 0 { dx = -dx; dy = -dy; pt1 = p2 }
        if dy < 0 { dy = -dy; sy = -1 }
        let vert = dy > dx
        if vert { swap(&dx, &dy); swap(&sx, &sy) }
        var err = dx - (dy + dy)
        let plusDelta = dx + dx, minusDelta = -(dy + dy)
        // minus step moves along the major axis, plus step additionally along the minor axis
        let (mx, my, px, py) = vert ? (0, sx, sy, 0) : (sx, 0, 0, sy)
        var x = pt1.x, y = pt1.y
        for _ in 0...dx {
            img[y * w + x] = 255
            let neg = err < 0
            err += minusDelta + (neg ? plusDelta : 0)
            x += mx + (neg ? px : 0)
            y += my + (neg ? py : 0)
        }
    }

    private struct PolyEdge { var y0: Int, y1: Int, x: Int64, dx: Int64 }

    /// fillPoly(img, [contour], 255, LINE_8, shift 0) — CollectPolyEdges + FillEdgeCollection.
    static func fillPoly(_ img: inout [UInt8], width w: Int, height h: Int, _ v: [Point]) {
        let shiftXY: Int64 = 16
        let one: Int64 = 1 << shiftXY
        var edges: [PolyEdge] = []
        guard !v.isEmpty else { return }
        var pt0 = (x: Int64(v[v.count - 1].x) << shiftXY, y: Int64(v[v.count - 1].y))
        for i in 0..<v.count {
            let pt1 = (x: Int64(v[i].x) << shiftXY, y: Int64(v[i].y))
            let t0 = Point(x: Int((pt0.x + (one >> 1)) >> shiftXY), y: Int(pt0.y))
            let t1 = Point(x: Int((pt1.x + (one >> 1)) >> shiftXY), y: Int(pt1.y))
            line8(&img, w, h, t0, t1)
            let c0x = Int64(t0.x) << shiftXY, c1x = Int64(t1.x) << shiftXY
            if pt0.y != pt1.y {
                let dx = (c1x - c0x) / (pt1.y - pt0.y)
                if pt0.y < pt1.y {
                    edges.append(PolyEdge(y0: Int(pt0.y), y1: Int(pt1.y), x: c0x, dx: dx))
                } else {
                    edges.append(PolyEdge(y0: Int(pt1.y), y1: Int(pt0.y), x: c1x, dx: dx))
                }
            }
            pt0 = pt1
        }
        fillEdges(&img, w, h, edges)
    }

    private static func fillEdges(_ img: inout [UInt8], _ w: Int, _ h: Int, _ input: [PolyEdge]) {
        let total = input.count
        if total < 2 { return }
        var yMax = Int.min, yMin = Int.max
        for e in input { yMin = min(yMin, e.y0); yMax = max(yMax, e.y1) }
        if yMax < 0 || yMin >= h { return }
        var edges = input.sorted { e1, e2 in
            if e1.y0 != e2.y0 { return e1.y0 < e2.y0 }
            if e1.x != e2.x { return e1.x < e2.x }
            return e1.dx < e2.dx
        }
        let delta: Int64 = (1 << 16) - 1
        edges.append(PolyEdge(y0: Int.max, y1: 0, x: 0, dx: 0))
        var active: [Int] = []   // indices into edges, kept in list order
        var i = 0
        yMax = min(yMax, h)
        var y = edges[0].y0
        while y < yMax {
            // drop finished edges, insert new ones (merge by x like the linked-list walk)
            active.removeAll { edges[$0].y1 == y }
            // merge new edges like the C list walk: skip active edges with x < e.x; a new edge never
            // goes before one inserted earlier in the same row
            var pos = 0
            while i < total && edges[i].y0 == y {
                let ex = edges[i].x
                while pos < active.count && edges[active[pos]].x < ex { pos += 1 }
                active.insert(i, at: pos)
                pos += 1
                i += 1
            }
            var k = 0
            while k + 1 < active.count {
                let l = active[k], r = active[k + 1]
                if y >= 0 {
                    var x1: Int, x2: Int
                    if edges[l].x > edges[r].x {
                        x1 = Int((edges[r].x + delta) >> 16); x2 = Int(edges[l].x >> 16)
                    } else {
                        x1 = Int((edges[l].x + delta) >> 16); x2 = Int(edges[r].x >> 16)
                    }
                    if x1 < w && x2 >= 0 {
                        x1 = max(x1, 0); x2 = min(x2, w - 1)
                        if x1 <= x2 { for x in x1...x2 { img[y * w + x] = 255 } }
                    }
                }
                edges[l].x += edges[l].dx
                edges[r].x += edges[r].dx
                k += 2
            }
            // bubble sort active list by x
            var swapped = true
            while swapped {
                swapped = false
                var j = 0
                while j + 1 < active.count {
                    if edges[active[j]].x > edges[active[j + 1]].x {
                        active.swapAt(j, j + 1); swapped = true
                    }
                    j += 1
                }
            }
            y += 1
        }
    }

    // MARK: - MORPH_ELLIPSE kernels, erode / dilate on 0/1 masks (out-of-image pixels ignored)

    /// Row spans `[j1, j2)` of `getStructuringElement(MORPH_ELLIPSE, (kw, kh))`.
    static func ellipseKernel(kw: Int, kh: Int) -> [(Int, Int)] {
        let r = kh / 2, c = kw / 2
        let invR2: Double = r != 0 ? 1.0 / (Double(r) * Double(r)) : 0
        var rows: [(Int, Int)] = []
        for i in 0..<kh {
            let dy = i - r
            var j1 = 0, j2 = 0
            if abs(dy) <= r {
                let q: Double = Double(r * r - dy * dy) * invR2
                let dx = cvRound(Double(c) * q.squareRoot())
                j1 = max(c - dx, 0)
                j2 = min(c + dx + 1, kw)
            }
            rows.append((j1, j2))
        }
        return rows
    }

    /// cv2.erode / cv2.dilate with a row-span kernel (anchor at (kw/2, kh/2)), BORDER_CONSTANT with the
    /// morphology default border value (out-of-image pixels never win). Input/output are 0/1.
    static func morph(_ src: [UInt8], width w: Int, height h: Int, kernel: [(Int, Int)], kw: Int,
                      erode: Bool) -> [UInt8] {
        let ax = kw / 2, ay = kernel.count / 2
        // per-row prefix counts of ones
        var pre = [Int32](repeating: 0, count: (w + 1) * h)
        for y in 0..<h {
            var acc: Int32 = 0
            let base = y * (w + 1)
            for x in 0..<w {
                acc += Int32(src[y * w + x])
                pre[base + x + 1] = acc
            }
        }
        var dst = [UInt8](repeating: 0, count: w * h)
        let rows = kernel.enumerated().filter { $0.element.1 > $0.element.0 }
        for y in 0..<h {
            for x in 0..<w {
                var hit = erode
                for (i, span) in rows {
                    let sy = y + i - ay
                    if sy < 0 || sy >= h { continue }
                    let lo = max(x + span.0 - ax, 0)
                    let hi = min(x + span.1 - 1 - ax, w - 1)
                    if lo > hi { continue }
                    let base = sy * (w + 1)
                    let cnt = Int(pre[base + hi + 1] - pre[base + lo])
                    if erode {
                        if cnt != hi - lo + 1 { hit = false; break }
                    } else if cnt > 0 {
                        hit = true; break
                    }
                }
                dst[y * w + x] = hit ? 1 : 0
            }
        }
        return dst
    }

    // MARK: - homr noise_filtering.create_grid

    /// `estimate_noise` of one tile: `sum(|filter2D(tile, CV_64F, [[1,-2,1],[-2,4,-2],[1,-2,1]])|) / (H*W)`
    /// with BORDER_REFLECT_101 inside the tile (every term is an integer, so the sum is exact).
    static func estimateNoise(_ g: [UInt8], stride: Int, x0: Int, y0: Int, w: Int, h: Int) -> Double {
        func refl(_ i: Int, _ n: Int) -> Int {
            if n == 1 { return 0 }
            var j = i
            while j < 0 || j >= n { j = j < 0 ? -j : 2 * n - 2 - j }
            return j
        }
        let k: [Int] = [1, -2, 1, -2, 4, -2, 1, -2, 1]
        var total = 0
        for y in 0..<h {
            let rows = [refl(y - 1, h), y, refl(y + 1, h)]
            for x in 0..<w {
                let cols = [refl(x - 1, w), x, refl(x + 1, w)]
                var acc = 0
                for a in 0..<3 {
                    let base = (y0 + rows[a]) * stride + x0
                    for b in 0..<3 { acc += k[a * 3 + b] * Int(g[base + cols[b]]) }
                }
                total += abs(acc)
            }
        }
        return Double(total) / Double(h * w)
    }

    /// `create_grid(gray, h // 20, w // 20)` (uint8 grid, float -> uint8 by C truncation).
    static func noiseGrid(_ g: [UInt8], width w: Int, height h: Int) -> (grid: [UInt8], rows: Int, cols: Int, m: Int, n: Int) {
        let m = h / 20, n = w / 20
        guard m > 0, n > 0 else { return ([], 0, 0, m, n) }
        let rows = (h + m - 1) / m, cols = (w + n - 1) / n
        var grid = [UInt8](repeating: 0, count: rows * cols)
        for i in 0..<rows {
            for j in 0..<cols {
                let y1 = i * m, x1 = j * n
                let th = min(m, h - y1), tw = min(n, w - x1)
                let v = estimateNoise(g, stride: w, x0: x1, y0: y1, w: tw, h: th)
                grid[i * cols + j] = UInt8(truncatingIfNeeded: Int(v))
            }
        }
        return (grid, rows, cols, m, n)
    }

    // MARK: - fitEllipse

    /// cv::RNG (multiply-with-carry), used only by fitEllipse's degenerate-input perturbation.
    struct RNG {
        var state: UInt64 = 0xffff_ffff
        mutating func next() -> UInt32 {
            state = UInt64(UInt32(truncatingIfNeeded: state)) &* 4_164_903_690 &+ (state >> 32)
            return UInt32(truncatingIfNeeded: state)
        }
        mutating func uniform(_ a: Float, _ b: Float) -> Float {
            let f: Float = Float(next()) * 2.3283064365386963e-10
            return f * (b - a) + a
        }
    }

    static func fitEllipse(_ pts: [Point], rng: inout RNG) -> RotatedRect {
        pts.count == 5 ? fitEllipseDirect(pts, rng: &rng) : fitEllipseNoDirect(pts, rng: &rng)
    }

    /// Least squares `min |A x - b|` via Householder QR (OpenCV uses SVD; same solution for full rank).
    static func leastSquares(_ aIn: [[Double]], _ bIn: [Double]) -> [Double] {
        var a = aIn, b = bIn
        let m = a.count, n = a.first?.count ?? 0
        guard m >= n, n > 0 else { return [Double](repeating: 0, count: n) }
        for k in 0..<n {
            var norm = 0.0
            for i in k..<m { norm += a[i][k] * a[i][k] }
            norm = norm.squareRoot()
            if norm == 0 { continue }
            let alpha = a[k][k] > 0 ? -norm : norm
            var v = [Double](repeating: 0, count: m)
            for i in k..<m { v[i] = a[i][k] }
            v[k] -= alpha
            var vv = 0.0
            for i in k..<m { vv += v[i] * v[i] }
            if vv == 0 { continue }
            for j in k..<n {
                var s = 0.0
                for i in k..<m { s += v[i] * a[i][j] }
                let f = 2 * s / vv
                for i in k..<m { a[i][j] -= f * v[i] }
            }
            var s = 0.0
            for i in k..<m { s += v[i] * b[i] }
            let f = 2 * s / vv
            for i in k..<m { b[i] -= f * v[i] }
        }
        var x = [Double](repeating: 0, count: n)
        let tol = 1e-12 * abs(a[0][0])
        for k in stride(from: n - 1, through: 0, by: -1) {
            var s = b[k]
            for j in (k + 1)..<max(k + 1, n) { s -= a[k][j] * x[j] }
            x[k] = abs(a[k][k]) > tol ? s / a[k][k] : 0
        }
        return x
    }

    private static func fitEllipseNoDirect(_ pts: [Point], rng: inout RNG) -> RotatedRect {
        let n = pts.count
        var pf = pts.map { Point2f(Float($0.x), Float($0.y)) }
        var cx: Float = 0, cy: Float = 0
        for p in pf { cx += p.x; cy += p.y }
        cx /= Float(n); cy /= Float(n)
        var s = 0.0
        for p in pf {
            let dx: Float = p.x - cx, dy: Float = p.y - cy
            let t: Float = abs(dx) + abs(dy)
            s += Double(t)
        }
        let scale = 100.0 / (s > Double(Float.ulpOfOne) ? s : Double(Float.ulpOfOne))
        func design() -> [[Double]] {
            pf.map { p -> [Double] in
                let dx: Float = p.x - cx, dy: Float = p.y - cy
                let px = Double(dx) * scale, py = Double(dy) * scale
                return [-px * px, -py * py, -px * py, px, py]
            }
        }
        var A = design()
        if isRankDeficient(A) {
            let eps = Float(s / Double(n * 2) * 1e-3)
            for i in 0..<n {
                let ox = rng.uniform(-eps, eps), oy = rng.uniform(-eps, eps)
                pf[i] = Point2f(pf[i].x + ox, pf[i].y + oy)
            }
            A = design()
        }
        let gfp = leastSquares(A, [Double](repeating: 10000, count: n))
        let rp01 = leastSquares([[2 * gfp[0], gfp[2]], [gfp[2], 2 * gfp[1]]], [gfp[3], gfp[4]])
        var A3: [[Double]] = []
        for p in pf {
            let dx: Float = p.x - cx, dy: Float = p.y - cy
            let px = Double(dx) * scale - rp01[0], py = Double(dy) * scale - rp01[1]
            A3.append([px * px, py * py, px * py])
        }
        let g = leastSquares(A3, [Double](repeating: 1, count: n))
        let rp4 = -0.5 * atan2(g[2], g[1] - g[0])
        let t = abs(g[2]) > 1e-8 ? g[2] / sin(-2.0 * rp4) : g[1] - g[0]
        var rp2 = abs(g[0] + g[1] - t)
        if rp2 > 1e-8 { rp2 = (2.0 / rp2).squareRoot() }
        var rp3 = abs(g[0] + g[1] + t)
        if rp3 > 1e-8 { rp3 = (2.0 / rp3).squareRoot() }
        var box = RotatedRect()
        box.cx = Float(rp01[0] / scale) + cx
        box.cy = Float(rp01[1] / scale) + cy
        box.w = Float(rp2 * 2 / scale)
        box.h = Float(rp3 * 2 / scale)
        if box.w > box.h {
            swap(&box.w, &box.h)
            box.angle = Float(90 + rp4 * 180 / Double.pi)
        }
        if box.angle < -180 { box.angle += 360 }
        if box.angle > 360 { box.angle -= 360 }
        return box
    }

    /// `wd[0] * FLT_EPSILON > wd[4]` (singular-value ratio) approximated via QR's R diagonal.
    private static func isRankDeficient(_ aIn: [[Double]]) -> Bool {
        let cols = aIn.first?.count ?? 0
        var a = aIn
        let m = a.count
        var diag: [Double] = []
        for k in 0..<min(cols, m) {
            var norm = 0.0
            for i in k..<m { norm += a[i][k] * a[i][k] }
            norm = norm.squareRoot()
            diag.append(norm)
            if norm == 0 { continue }
            let alpha = a[k][k] > 0 ? -norm : norm
            var v = [Double](repeating: 0, count: m)
            for i in k..<m { v[i] = a[i][k] }
            v[k] -= alpha
            var vv = 0.0
            for i in k..<m { vv += v[i] * v[i] }
            if vv == 0 { continue }
            for j in k..<cols {
                var sum = 0.0
                for i in k..<m { sum += v[i] * a[i][j] }
                let f = 2 * sum / vv
                for i in k..<m { a[i][j] -= f * v[i] }
            }
        }
        guard let mx = diag.max(), let mn = diag.min() else { return true }
        return mx * Double(Float.ulpOfOne) > mn
    }

    /// Real eigenvectors of a 3x3 matrix (rows), for fitEllipseDirect's selection step.
    private static func eigenvectors3(_ m: [[Double]]) -> [[Double]] {
        // characteristic polynomial  l^3 + p2 l^2 + p1 l + p0
        let tr = m[0][0] + m[1][1] + m[2][2]
        let minors = m[0][0] * m[1][1] - m[0][1] * m[1][0] + m[0][0] * m[2][2] - m[0][2] * m[2][0]
            + m[1][1] * m[2][2] - m[1][2] * m[2][1]
        let d0 = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        let d1 = m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        let d2 = m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
        let det = d0 - d1 + d2
        let roots = cubicRoots(-tr, minors, -det)
        return roots.map { l -> [Double] in
            let r0 = [m[0][0] - l, m[0][1], m[0][2]]
            let r1 = [m[1][0], m[1][1] - l, m[1][2]]
            let r2 = [m[2][0], m[2][1], m[2][2] - l]
            let cands = [cross3(r0, r1), cross3(r0, r2), cross3(r1, r2)]
            var best = cands[0]
            var bn = 0.0
            for c in cands {
                let nn = c[0] * c[0] + c[1] * c[1] + c[2] * c[2]
                if nn > bn { bn = nn; best = c }
            }
            let nrm = bn.squareRoot()
            return nrm > 0 ? best.map { $0 / nrm } : [0, 0, 0]
        }
    }

    private static func cross3(_ a: [Double], _ b: [Double]) -> [Double] {
        [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    }

    /// Real roots of x^3 + a x^2 + b x + c (complex pairs contribute their real part, like JAMA's
    /// real-Schur eigenvector rows would not be selected anyway).
    private static func cubicRoots(_ a: Double, _ b: Double, _ c: Double) -> [Double] {
        let q = (a * a - 3 * b) / 9
        let r = (2 * a * a * a - 9 * a * b + 27 * c) / 54
        if r * r < q * q * q {
            let th = acos(max(-1, min(1, r / (q * q * q).squareRoot())))
            let sq = -2 * q.squareRoot()
            return [sq * cos(th / 3) - a / 3, sq * cos((th + 2 * Double.pi) / 3) - a / 3,
                    sq * cos((th - 2 * Double.pi) / 3) - a / 3]
        }
        let sgn: Double = r < 0 ? -1 : 1
        let aa = -sgn * pow(abs(r) + (r * r - q * q * q).squareRoot(), 1.0 / 3.0)
        let bb = aa != 0 ? q / aa : 0
        let x1 = (aa + bb) - a / 3
        let re = -(aa + bb) / 2 - a / 3
        return [x1, re, re]
    }

    private static func fitEllipseDirect(_ pts: [Point], rng: inout RNG) -> RotatedRect {
        let n = pts.count
        var cxd = 0.0, cyd = 0.0
        for p in pts { cxd += Double(Float(p.x)); cyd += Double(Float(p.y)) }
        cxd /= Double(n); cyd /= Double(n)
        var s = 0.0
        for p in pts { s += abs(Double(Float(p.x)) - cxd) + abs(Double(Float(p.y)) - cyd) }
        let scale = 100.0 / (s > Double(Float.ulpOfOne) ? s : Double(Float.ulpOfOne))
        var eps: Float = 0
        for _ in 0..<2 {
            var A: [[Double]] = []
            for p in pts {
                let ox = rng.uniform(-eps, eps), oy = rng.uniform(-eps, eps)
                let fx: Float = Float(p.x) + ox
                let fy: Float = Float(p.y) + oy
                let px = (Double(fx) - cxd) * scale, py = (Double(fy) - cyd) * scale
                A.append([px * px, px * py, py * py, px, py, 1.0])
            }
            var dm = [[Double]](repeating: [Double](repeating: 0, count: 6), count: 6)
            for i in 0..<6 {
                for j in 0..<6 {
                    var acc = 0.0
                    for r in A { acc += r[i] * r[j] }
                    dm[i][j] = acc * (1.0 / Double(n))
                }
            }
            let fit = directSolve(dm)
            guard let (tm, ts, pvec) = fit else {
                eps = Float(s / Double(n * 2) * 1e-2)
                continue
            }
            return directBox(tm: tm, ts: ts, pVec: pvec, scale: scale, cx: cxd, cy: cyd)
        }
        return fitEllipseNoDirect(pts, rng: &rng)
    }

    private static func directSolve(_ D: [[Double]]) -> ([[Double]], Double, [Double])? {
        // Transcribed from OpenCV 5.0.0 fitEllipseDirect (TM, Ts, M).
        var tm = [[Double]](repeating: [0, 0, 0], count: 3)
        for c in 0..<3 {
            tm[0][c] = tmRow0(D, c)
            tm[1][c] = tmRow1(D, c)
            tm[2][c] = tmRow2(D, c)
        }
        let ts = tsValue(D)
        if abs(ts) < Double.ulpOfOne { return nil }
        var mm = [[Double]](repeating: [0, 0, 0], count: 3)
        for c in 0..<3 {
            let a0: Double = D[2][3] * tm[0][c] + D[2][4] * tm[1][c] + D[2][5] * tm[2][c]
            let a1: Double = D[1][3] * tm[0][c] + D[1][4] * tm[1][c] + D[1][5] * tm[2][c]
            let a2: Double = D[0][3] * tm[0][c] + D[0][4] * tm[1][c] + D[0][5] * tm[2][c]
            mm[0][c] = (D[2][c] + a0 / ts) / 2.0
            mm[1][c] = -D[1][c] - a1 / ts
            mm[2][c] = (D[0][c] + a2 / ts) / 2.0
        }
        let ev = eigenvectors3(mm)
        let cond = ev.map { 4.0 * $0[0] * $0[2] - $0[1] * $0[1] }
        let i: Int = cond[0] < cond[1] ? (cond[1] < cond[2] ? 2 : 1) : (cond[0] < cond[2] ? 2 : 0)
        let v = ev[i]
        let vn2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2]
        if !(cond[i] > 1e-6 * vn2) { return nil }
        var norm = vn2.squareRoot()
        let sg = (v[0] < 0 ? -1.0 : 1.0) * (v[1] < 0 ? -1.0 : 1.0) * (v[2] < 0 ? -1.0 : 1.0)
        if sg <= 0 { norm = -norm }
        return (tm, ts, v.map { $0 / norm })
    }

    private static func tmRow0(_ D: [[Double]], _ c: Int) -> Double {
        var r: Double = (D[c][5] * D[3][5] * D[4][4])
        r -= D[c][5] * D[3][4] * D[4][5]
        r -= D[c][4] * D[3][5] * D[5][4]
        r += D[c][3] * D[4][5] * D[5][4]
        r += D[c][4] * D[3][4] * D[5][5]
        r -= D[c][3] * D[4][4] * D[5][5]
        return r
    }

    private static func tmRow1(_ D: [[Double]], _ c: Int) -> Double {
        var r: Double = (D[c][5] * D[3][3] * D[4][5])
        r -= D[c][5] * D[3][5] * D[4][3]
        r += D[c][4] * D[3][5] * D[5][3]
        r -= D[c][3] * D[4][5] * D[5][3]
        r -= D[c][4] * D[3][3] * D[5][5]
        r += D[c][3] * D[4][3] * D[5][5]
        return r
    }

    private static func tmRow2(_ D: [[Double]], _ c: Int) -> Double {
        var r: Double = (D[c][5] * D[3][4] * D[4][3])
        r -= D[c][5] * D[3][3] * D[4][4]
        r -= D[c][4] * D[3][4] * D[5][3]
        r += D[c][3] * D[4][4] * D[5][3]
        r += D[c][4] * D[3][3] * D[5][4]
        r -= D[c][3] * D[4][3] * D[5][4]
        return r
    }

    private static func tsValue(_ D: [[Double]]) -> Double {
        var r: Double = -(D[3][5] * D[4][4] * D[5][3])
        r += D[3][4] * D[4][5] * D[5][3]
        r += D[3][5] * D[4][3] * D[5][4]
        r -= D[3][3] * D[4][5] * D[5][4]
        r -= D[3][4] * D[4][3] * D[5][5]
        r += D[3][3] * D[4][4] * D[5][5]
        return r
    }

    private static func directBox(tm: [[Double]], ts: Double, pVec p: [Double], scale: Double,
                                  cx: Double, cy: Double) -> RotatedRect {
        let q0 = (tm[0][0] * p[0] + tm[0][1] * p[1] + tm[0][2] * p[2]) / ts
        let q1 = (tm[1][0] * p[0] + tm[1][1] * p[1] + tm[1][2] * p[2]) / ts
        let q2 = (tm[2][0] * p[0] + tm[2][1] * p[1] + tm[2][2] * p[2]) / ts
        let u1a: Double = p[2] * q0 * q0 - p[1] * q0 * q1
        let u1b: Double = p[0] * q1 * q1 + p[1] * p[1] * q2
        let u1 = u1a + u1b
        let u2 = p[0] * p[2] * q2
        let l1 = (p[1] * p[1] + (p[0] - p[2]) * (p[0] - p[2])).squareRoot()
        let l2 = p[0] + p[2]
        let l3 = p[1] * p[1] - 4 * p[0] * p[2]
        let p1 = 2 * p[2] * q0 - p[1] * q1
        let p2 = 2 * p[0] * q1 - p[1] * q0
        let x0 = (p1 / l3 / scale) + cx
        let y0 = (p2 / l3 / scale) + cy
        let a = 2.0.squareRoot() * ((u1 - 4.0 * u2) / ((l1 - l2) * l3)).squareRoot() / scale
        let b = 2.0.squareRoot() * (-1.0 * ((u1 - 4.0 * u2) / ((l1 + l2) * l3))).squareRoot() / scale
        let theta: Double
        if p[1] == 0 {
            theta = p[0] < p[2] ? 0 : Double.pi / 2
        } else {
            theta = Double.pi / 2 + 0.5 * atan2(p[1], p[0] - p[2])
        }
        var box = RotatedRect()
        box.cx = Float(x0); box.cy = Float(y0)
        box.w = Float(2.0 * a); box.h = Float(2.0 * b)
        if box.w > box.h {
            swap(&box.w, &box.h)
            box.angle = Float(fmod(90 + theta * 180 / Double.pi, 180.0))
        } else {
            box.angle = Float(fmod(theta * 180 / Double.pi, 180.0))
        }
        return box
    }

    static let sinTable: [Float] = [
        0.0000000, 0.0174524, 0.0348995, 0.0523360, 0.0697565, 0.0871557, 0.1045285, 0.1218693,
        0.1391731, 0.1564345, 0.1736482, 0.1908090, 0.2079117, 0.2249511, 0.2419219, 0.2588190,
        0.2756374, 0.2923717, 0.3090170, 0.3255682, 0.3420201, 0.3583679, 0.3746066, 0.3907311,
        0.4067366, 0.4226183, 0.4383711, 0.4539905, 0.4694716, 0.4848096, 0.5000000, 0.5150381,
        0.5299193, 0.5446390, 0.5591929, 0.5735764, 0.5877853, 0.6018150, 0.6156615, 0.6293204,
        0.6427876, 0.6560590, 0.6691306, 0.6819984, 0.6946584, 0.7071068, 0.7193398, 0.7313537,
        0.7431448, 0.7547096, 0.7660444, 0.7771460, 0.7880108, 0.7986355, 0.8090170, 0.8191520,
        0.8290376, 0.8386706, 0.8480481, 0.8571673, 0.8660254, 0.8746197, 0.8829476, 0.8910065,
        0.8987940, 0.9063078, 0.9135455, 0.9205049, 0.9271839, 0.9335804, 0.9396926, 0.9455186,
        0.9510565, 0.9563048, 0.9612617, 0.9659258, 0.9702957, 0.9743701, 0.9781476, 0.9816272,
        0.9848078, 0.9876883, 0.9902681, 0.9925462, 0.9945219, 0.9961947, 0.9975641, 0.9986295,
        0.9993908, 0.9998477, 1.0000000, 0.9998477, 0.9993908, 0.9986295, 0.9975641, 0.9961947,
        0.9945219, 0.9925462, 0.9902681, 0.9876883, 0.9848078, 0.9816272, 0.9781476, 0.9743701,
        0.9702957, 0.9659258, 0.9612617, 0.9563048, 0.9510565, 0.9455186, 0.9396926, 0.9335804,
        0.9271839, 0.9205049, 0.9135455, 0.9063078, 0.8987940, 0.8910065, 0.8829476, 0.8746197,
        0.8660254, 0.8571673, 0.8480481, 0.8386706, 0.8290376, 0.8191520, 0.8090170, 0.7986355,
        0.7880108, 0.7771460, 0.7660444, 0.7547096, 0.7431448, 0.7313537, 0.7193398, 0.7071068,
        0.6946584, 0.6819984, 0.6691306, 0.6560590, 0.6427876, 0.6293204, 0.6156615, 0.6018150,
        0.5877853, 0.5735764, 0.5591929, 0.5446390, 0.5299193, 0.5150381, 0.5000000, 0.4848096,
        0.4694716, 0.4539905, 0.4383711, 0.4226183, 0.4067366, 0.3907311, 0.3746066, 0.3583679,
        0.3420201, 0.3255682, 0.3090170, 0.2923717, 0.2756374, 0.2588190, 0.2419219, 0.2249511,
        0.2079117, 0.1908090, 0.1736482, 0.1564345, 0.1391731, 0.1218693, 0.1045285, 0.0871557,
        0.0697565, 0.0523360, 0.0348995, 0.0174524, 0.0000000, -0.0174524, -0.0348995, -0.0523360,
        -0.0697565, -0.0871557, -0.1045285, -0.1218693, -0.1391731, -0.1564345, -0.1736482, -0.1908090,
        -0.2079117, -0.2249511, -0.2419219, -0.2588190, -0.2756374, -0.2923717, -0.3090170, -0.3255682,
        -0.3420201, -0.3583679, -0.3746066, -0.3907311, -0.4067366, -0.4226183, -0.4383711, -0.4539905,
        -0.4694716, -0.4848096, -0.5000000, -0.5150381, -0.5299193, -0.5446390, -0.5591929, -0.5735764,
        -0.5877853, -0.6018150, -0.6156615, -0.6293204, -0.6427876, -0.6560590, -0.6691306, -0.6819984,
        -0.6946584, -0.7071068, -0.7193398, -0.7313537, -0.7431448, -0.7547096, -0.7660444, -0.7771460,
        -0.7880108, -0.7986355, -0.8090170, -0.8191520, -0.8290376, -0.8386706, -0.8480481, -0.8571673,
        -0.8660254, -0.8746197, -0.8829476, -0.8910065, -0.8987940, -0.9063078, -0.9135455, -0.9205049,
        -0.9271839, -0.9335804, -0.9396926, -0.9455186, -0.9510565, -0.9563048, -0.9612617, -0.9659258,
        -0.9702957, -0.9743701, -0.9781476, -0.9816272, -0.9848078, -0.9876883, -0.9902681, -0.9925462,
        -0.9945219, -0.9961947, -0.9975641, -0.9986295, -0.9993908, -0.9998477, -1.0000000, -0.9998477,
        -0.9993908, -0.9986295, -0.9975641, -0.9961947, -0.9945219, -0.9925462, -0.9902681, -0.9876883,
        -0.9848078, -0.9816272, -0.9781476, -0.9743701, -0.9702957, -0.9659258, -0.9612617, -0.9563048,
        -0.9510565, -0.9455186, -0.9396926, -0.9335804, -0.9271839, -0.9205049, -0.9135455, -0.9063078,
        -0.8987940, -0.8910065, -0.8829476, -0.8746197, -0.8660254, -0.8571673, -0.8480481, -0.8386706,
        -0.8290376, -0.8191520, -0.8090170, -0.7986355, -0.7880108, -0.7771460, -0.7660444, -0.7547096,
        -0.7431448, -0.7313537, -0.7193398, -0.7071068, -0.6946584, -0.6819984, -0.6691306, -0.6560590,
        -0.6427876, -0.6293204, -0.6156615, -0.6018150, -0.5877853, -0.5735764, -0.5591929, -0.5446390,
        -0.5299193, -0.5150381, -0.5000000, -0.4848096, -0.4694716, -0.4539905, -0.4383711, -0.4226183,
        -0.4067366, -0.3907311, -0.3746066, -0.3583679, -0.3420201, -0.3255682, -0.3090170, -0.2923717,
        -0.2756374, -0.2588190, -0.2419219, -0.2249511, -0.2079117, -0.1908090, -0.1736482, -0.1564345,
        -0.1391731, -0.1218693, -0.1045285, -0.0871557, -0.0697565, -0.0523360, -0.0348995, -0.0174524,
        -0.0000000, 0.0174524, 0.0348995, 0.0523360, 0.0697565, 0.0871557, 0.1045285, 0.1218693,
        0.1391731, 0.1564345, 0.1736482, 0.1908090, 0.2079117, 0.2249511, 0.2419219, 0.2588190,
        0.2756374, 0.2923717, 0.3090170, 0.3255682, 0.3420201, 0.3583679, 0.3746066, 0.3907311,
        0.4067366, 0.4226183, 0.4383711, 0.4539905, 0.4694716, 0.4848096, 0.5000000, 0.5150381,
        0.5299193, 0.5446390, 0.5591929, 0.5735764, 0.5877853, 0.6018150, 0.6156615, 0.6293204,
        0.6427876, 0.6560590, 0.6691306, 0.6819984, 0.6946584, 0.7071068, 0.7193398, 0.7313537,
        0.7431448, 0.7547096, 0.7660444, 0.7771460, 0.7880108, 0.7986355, 0.8090170, 0.8191520,
        0.8290376, 0.8386706, 0.8480481, 0.8571673, 0.8660254, 0.8746197, 0.8829476, 0.8910065,
        0.8987940, 0.9063078, 0.9135455, 0.9205049, 0.9271839, 0.9335804, 0.9396926, 0.9455186,
        0.9510565, 0.9563048, 0.9612617, 0.9659258, 0.9702957, 0.9743701, 0.9781476, 0.9816272,
        0.9848078, 0.9876883, 0.9902681, 0.9925462, 0.9945219, 0.9961947, 0.9975641, 0.9986295,
        0.9993908, 0.9998477, 1.0000000,    ]
}
