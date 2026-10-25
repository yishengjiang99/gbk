// SPDX-License-Identifier: AGPL-3.0-or-later
//
// omr-sheet-cam — homr staff detection (page pipeline, milestone 2).
// Port of liebharc/homr @ 7d97c3cee4ad772b50266fdf9dc78bbf9064701e (AGPL-3.0): homr/staff_detection.py
// (StaffLineSegment, StaffAnchor, RawStaff, connect_staff_lines, find_staff_anchors,
// find_raw_staffs_by_connecting_line_fragments, remove_duplicate_staffs, resample_staff(s),
// filter_edge_of_vision, filter_unusual_anchors, init_zone, filter_line_peaks, find_horizontal_lines,
// predict_other_anchors_from_clefs, break_wide_fragments, detect_staff), homr/find_peaks.py and the
// StaffPoint / Staff parts of homr/model.py.

import Foundation

/// homr `StaffPoint`.
struct HStaffPoint {
    var x: Double
    var y: [Double]
    var angle: Double
    var averageUnitSize: Double { NP.mean(NP.diff(y)) }

    func merge(_ o: HStaffPoint) -> HStaffPoint {
        HStaffPoint(x: x, y: (y + o.y).sorted(), angle: (angle + o.angle) / 2)
    }

    /// StaffPoint.to_bounding_box: `BoundingBox([int(x), int(y[0]), int(x), int(y[-1])])`.
    func toBoundingBox() -> HBox {
        HBox.axis(x1: Int(x), y1: Int(y[0]), x2: Int(x), y2: Int(y[y.count - 1]))
    }
}

/// homr `Staff` (reference identity like the Python object).
final class HStaff {
    let grid: [HStaffPoint]
    let minX: Double, maxX: Double, minY: Double, maxY: Double
    let averageUnitSize: Double
    var isGrandstaff = false

    /// nil when the grid is empty (homr would raise IndexError).
    init?(grid: [HStaffPoint]) {
        guard let first = grid.first, let last = grid.last else { return nil }
        self.grid = grid
        minX = first.x
        maxX = last.x
        minY = grid.map { $0.y.min()! }.min()!
        maxY = grid.map { $0.y.max()! }.max()!
        averageUnitSize = NP.median(grid.map { $0.averageUnitSize })
    }

    func getAt(_ x: Double) -> HStaffPoint? {
        var best = grid[0]
        var bd = abs(best.x - x)
        for p in grid.dropFirst() where abs(p.x - x) < bd { best = p; bd = abs(p.x - x) }
        return bd > 50 ? nil : best
    }

    func yDistanceTo(_ p: (Double, Double)) -> Double {
        guard let sp = getAt(p.0) else { return 1e10 }
        return sp.y.map { abs($0 - p.1) }.min()!
    }

    func merge(_ o: HStaff) -> HStaff? {
        var a: [Int: HStaffPoint] = [:], b: [Int: HStaffPoint] = [:]
        for p in grid { a[NP.round(p.x)] = p }
        for p in o.grid { b[NP.round(p.x)] = p }
        let xs = Set(a.keys).intersection(b.keys).sorted()
        guard let r = HStaff(grid: xs.map { a[$0]!.merge(b[$0]!) }) else { return nil }
        r.isGrandstaff = true
        return r
    }
}

final class StaffLineSegment {
    let debugId: Int
    let fragments: [HBox]
    let minX: Double, maxX: Double, minY: Double, maxY: Double

    init(_ debugId: Int, _ frags: [HBox]) {
        self.debugId = debugId
        fragments = frags.enumerated().sorted { $0.element.cx != $1.element.cx ? $0.element.cx < $1.element.cx : $0.offset < $1.offset }
            .map { $0.element }
        minX = frags.map { $0.cx - $0.w / 2 }.min()!
        maxX = frags.map { $0.cx + $0.w / 2 }.max()!
        minY = frags.map { $0.cy - $0.h / 2 }.min()!
        maxY = frags.map { $0.cy + $0.h / 2 }.max()!
    }

    func merge(_ o: StaffLineSegment) -> StaffLineSegment {
        var lines = fragments
        for f in o.fragments where !lines.contains(f) { lines.append(f) }
        return StaffLineSegment(debugId, lines)
    }

    func getAt(_ x: Double) -> HBox? {
        let tol = 10.0
        return fragments.first { x >= $0.cx - $0.w / 2 - tol && x <= $0.cx + $0.w / 2 + tol }
    }
}

final class StaffAnchor {
    let staffLines: [StaffLineSegment]
    let symbol: HBox
    let averageUnitSize: Double
    let maxY: Double, minY: Double
    let zone: (start: Int, stop: Int)

    init(_ lines: [StaffLineSegment], _ symbol: HBox) {
        staffLines = lines
        self.symbol = symbol
        let cx: Double = symbol.cx
        var ys: [Double] = []
        for line in lines {
            let y: Double = line.fragments[0].centerExtrapolated(cx)
            ys.append(y)
        }
        ys.sort()
        var deltas: [Double] = []
        if ys.count > 1 {
            for i in 1..<ys.count {
                let d: Double = abs(ys[i] - ys[i - 1])
                deltas.append(d)
            }
        }
        averageUnitSize = deltas.isEmpty ? 0 : NP.mean(deltas)
        var mx: Double = -Double.infinity
        var mn: Double = Double.infinity
        for line in lines {
            let a: Double = line.maxY
            let b: Double = line.minY
            if a > mx { mx = a }
            if b < mn { mn = b }
        }
        maxY = mx
        minY = mn
        let lo: Double = minY - 5 * averageUnitSize
        let hi: Double = maxY + 5 * averageUnitSize
        zone = (Int(lo), Int(hi))
    }
}

final class RawStaff {
    let box: HBox
    let staffId: Int
    let lines: [StaffLineSegment]
    let anchors: [StaffAnchor]
    var minX: Double { box.cx - box.w / 2 }
    var maxX: Double { box.cx + box.w / 2 }

    init(_ id: Int, _ lines: [StaffLineSegment], _ anchors: [StaffAnchor]) {
        let pts = lines.flatMap { $0.fragments.flatMap { $0.contour } }
        box = HBox.rotated(HBox.raw(CVShapes.minAreaRect(pts)), contour: pts)
        staffId = id
        self.lines = lines
        self.anchors = anchors
    }

    func merge(_ o: RawStaff) -> RawStaff {
        let merged = lines.enumerated().map { o.lines[$0.offset].merge($0.element) }
        return RawStaff(staffId, merged, anchors + o.anchors)
    }
}

enum StaffDetection {
    typealias Point = CVContours.Point

    // MARK: connect_staff_lines

    static func connectStaffLines(_ staffLines: [HBox], unitSize: Double) -> [StaffLineSegment] {
        // sorted(key=bottom_left[0], reverse=True) is stable; pop() then walks it from the end
        var stack = staffLines.enumerated().sorted {
            $0.element.bottomLeft.0 != $1.element.bottomLeft.0 ? $0.element.bottomLeft.0 > $1.element.bottomLeft.0
                : $0.offset < $1.offset
        }.map { $0.element }
        var result: [[HBox]] = []
        var active: [Int] = []   // indices into result
        var lastCleanup = 0.0
        let maxGap = 5 * unitSize
        while let cur = stack.popLast() {
            let x = cur.bottomLeft.0
            if x - lastCleanup > maxGap {
                active = active.filter { x - result[$0][result[$0].count - 1].bottomRight.0 < maxGap }
                lastCleanup = x
            }
            if cur.w < unitSize / 5 { continue }
            var connected = false
            for a in active where result[a][result[a].count - 1].isOverlappingExtrapolated(cur, unitSize: unitSize) {
                result[a].append(cur)
                connected = true
            }
            if !connected {
                result.append([cur])
                active.append(result.count - 1)
            }
        }
        let ordered = result.enumerated().sorted {
            $0.element[0].cy != $1.element[0].cy ? $0.element[0].cy < $1.element[0].cy : $0.offset < $1.offset
        }.map { $0.element }
        return ordered.enumerated().map { StaffLineSegment($0.offset, $0.element) }
    }

    private static func extrapolatedLineY(_ line: StaffLineSegment, _ x: Double) -> Double {
        (line.getAt(x) ?? line.fragments[0]).centerExtrapolated(x)
    }

    static func areLinesCrossing(_ lines: [StaffLineSegment]) -> Bool {
        for i in 0..<lines.count {
            for j in (i + 1)..<max(i + 1, lines.count) {
                let start = max(lines[i].minX, lines[j].minX)
                let stop = min(lines[i].maxX, lines[j].maxX)
                if start >= stop { continue }
                let ds = extrapolatedLineY(lines[i], start) - extrapolatedLineY(lines[j], start)
                let de = extrapolatedLineY(lines[i], stop) - extrapolatedLineY(lines[j], stop)
                if ds == 0 || de == 0 || (ds > 0) != (de > 0) { return true }
            }
        }
        return false
    }

    static func areLinesParallel(_ lines: [StaffLineSegment], unitSize: Double) -> Bool {
        let frags = lines.flatMap { $0.fragments }
        if frags.isEmpty { return false }
        let avg = NP.mean(frags.map { $0.angle })
        for f in frags where abs(f.angle - avg) > 10 && f.w > 2 * unitSize { return false }
        return true
    }

    static func beginsOrEndsOnOneStaffLine(_ line: HBox, _ staffLines: [StaffLineSegment], unitSize: Double) -> Bool {
        for s in staffLines {
            guard let f = s.getAt(line.cx) else { continue }
            if abs(f.centerExtrapolated(line.cx) - line.cy) < unitSize { return true }
        }
        return false
    }

    // MARK: find_staff_anchors

    static func findStaffAnchors(_ staffLines: [HBox], _ symbols: [HBox], areClefs: Bool) -> [StaffAnchor] {
        var result: [StaffAnchor] = []
        let shifts: [Double] = areClefs ? [-10, 0, 10, 30, 60, 80] : [-10, -5, 0, 5, 10]
        for center in symbols {
            for d in shifts {
                let symbol = d == 0 ? center : center.moveX(d)
                let eus = Double(NP.round(symbol.h / 4))
                let thick = symbol.makeTaller(eus)
                let overlapping = staffLines.filter { $0.isIntersecting(thick) }
                var connected = connectStaffLines(overlapping, unitSize: eus)
                if connected.count > 5 {
                    connected = connected.filter { $0.maxX - $0.minX > 2 * eus }
                }
                if connected.count != 5 { continue }
                if !areLinesParallel(connected, unitSize: eus) { continue }
                if areLinesCrossing(connected) { continue }
                if !areClefs && !beginsOrEndsOnOneStaffLine(symbol, connected, unitSize: eus) { continue }
                result.append(StaffAnchor(connected, symbol))
            }
        }
        return result
    }

    // MARK: raw staffs

    static func staffForAnchor(_ anchor: StaffAnchor, _ staffs: [RawStaff]) -> Int? {
        for (k, s) in staffs.enumerated() {
            for (i, al) in anchor.staffLines.enumerated() where Set(al.fragments).isSubset(of: Set(s.lines[i].fragments)) {
                return k
            }
        }
        return nil
    }

    static func findRawStaffs(_ anchors: [StaffAnchor], _ fragments: [HBox]) -> [RawStaff] {
        var staffs: [RawStaff] = []
        var staffId = 0
        for anchor in anchors {
            let existing = staffForAnchor(anchor, staffs)
            let zoneFrags = fragments.filter { $0.cy >= Double(anchor.zone.start) && $0.cy <= Double(anchor.zone.stop) }
            let connected = connectStaffLines(zoneFrags, unitSize: anchor.averageUnitSize)
            var lines: [StaffLineSegment] = []
            for al in anchor.staffLines {
                let req = Set(al.fragments)
                let matching = connected.filter { req.isSubset(of: Set($0.fragments)) }
                lines.append(matching.count == 1 ? matching[0] : al)
            }
            let fresh = RawStaff(staffId, lines, [anchor])
            if let e = existing {
                let old = staffs.remove(at: e)
                staffs.append(old.merge(fresh))
            } else {
                staffs.append(fresh)
            }
            staffId += 1
        }
        return staffs
    }

    static func removeDuplicateStaffs(_ staffs: [RawStaff]) -> [RawStaff] {
        var result: [RawStaff] = []
        for s in staffs {
            let overlapping = result.filter { s.box.isOverlapping($0.box) }
            if overlapping.isEmpty { result.append(s); continue }
            if overlapping.count >= 2 { continue }
            if overlapping[0].anchors.count < s.anchors.count {
                let ob = overlapping[0].box
                result = result.filter { $0.box != ob }
                result.append(s)
            }
        }
        return result
    }

    // MARK: resample

    static func resampleSegment(_ anchor: StaffAnchor, _ staff: RawStaff, _ xs: [Int]) -> [HStaffPoint] {
        let x0 = anchor.symbol.cx
        let lf = anchor.staffLines.map { $0.fragments[0] }
        var previous = HStaffPoint(x: x0, y: lf.map { $0.centerExtrapolated(x0) }, angle: NP.mean(lf.map { $0.angle }))
        let unit = anchor.averageUnitSize
        var out: [HStaffPoint] = []
        for xi in xs {
            let x = Double(xi)
            let lines = staff.lines.map { $0.getAt(x) }
            var axis: [Double?] = lines.map { $0?.centerExtrapolated(x) }
            let values = axis.compactMap { $0 }
            if values.isEmpty { continue }
            let deltas = NP.diff(values)
            for (i, d) in deltas.enumerated() where d < 0.5 * unit {
                axis[i] = nil
                axis[i + 1] = nil
            }
            for (i, py) in previous.y.enumerated() where i < axis.count {
                if let c = axis[i], abs(c - py) > 0.5 * unit { axis[i] = nil }
            }
            var prev = -1
            let n = axis.count
            for i in Array(0..<n) + Array((0..<n).reversed()) {
                if axis[i] != nil {
                    prev = i
                } else if prev >= 0, let cv = axis[prev] {
                    axis[i] = cv + unit * Double(i - prev)
                }
            }
            if axis.contains(where: { $0 == nil }) { continue }
            let angle = NP.mean(lines.compactMap { $0?.angle })
            previous = HStaffPoint(x: x, y: axis.map { $0! }, angle: angle)
            out.append(previous)
        }
        return out
    }

    /// Python `range(start, stop, step)` as an array.
    static func pyRange(_ start: Int, _ stop: Int, _ step: Int) -> [Int] {
        var r: [Int] = []
        var v = start
        while step > 0 ? v < stop : v > stop { r.append(v); v += step }
        return r
    }

    static func resampleStaff(_ staff: RawStaff) -> HStaff? {
        let anchors = staff.anchors.enumerated().sorted {
            $0.element.symbol.cx != $1.element.symbol.cx ? $0.element.symbol.cx < $1.element.symbol.cx : $0.offset < $1.offset
        }.map { $0.element }
        let density = 10.0
        func rtd(_ x: Double) -> Int { NP.round(x / density) * 10 }
        let start = (staff.minX / density).rounded(.down) * density
        let stop = ((staff.maxX / density).rounded(.down) + 1) * density
        var grid: [HStaffPoint] = []
        var x = start
        for (i, a) in anchors.enumerated() {
            let toLeft = pyRange(rtd(x), rtd(a.symbol.cx), 10)
            let toRight: [Int]
            let rightStop: Int
            if i < anchors.count - 1 {
                let s = Int(a.symbol.cx)
                let e = Int((a.symbol.cx + anchors[i + 1].symbol.cx) / 2)
                toRight = pyRange(s, e, 10); rightStop = e
            } else {
                let s = rtd(a.symbol.cx), e = rtd(stop)
                toRight = pyRange(s, e, 10); rightStop = e
            }
            x = Double(rightStop)
            grid.append(contentsOf: resampleSegment(a, staff, toLeft.reversed()).reversed())
            grid.append(contentsOf: resampleSegment(a, staff, toRight))
        }
        return HStaff(grid: grid)
    }

    static func filterEdgeOfVision(_ staffs: [HStaff], width: Int, height: Int) -> [HStaff] {
        if staffs.isEmpty { return staffs }
        let usual = NP.mean(staffs.map { $0.maxX - $0.minX })
        return staffs.filter { s in
            if s.maxY >= Double(height) || s.minY < 0 { return false }
            let shorter = s.maxX - s.minX < usual / 2
            let beyond = s.minX < 0.01 * Double(width) || s.maxX > 0.99 * Double(width)
            return !(beyond && shorter)
        }
    }

    static func filterUnusualAnchors(_ anchors: [StaffAnchor]) -> [StaffAnchor] {
        if anchors.isEmpty { return anchors }
        let u = anchors.map { $0.averageUnitSize }
        let avg = NP.mean(u), dev = NP.std(u)
        return anchors.filter { !(abs($0.averageUnitSize - avg) > 3 * dev) }
    }

    // MARK: anchors predicted from clefs

    static func initZone(_ clefAnchors: [StaffAnchor], width: Int) -> [(Int, Int)] {
        var ranges = clefAnchors.map { c -> (Int, Int) in
            (max(Int(c.symbol.bottomLeft.0), 0), min(Int(c.symbol.topRight.0 + 10), width))
        }
        ranges = ranges.enumerated().sorted { $0.element.0 != $1.element.0 ? $0.element.0 < $1.element.0 : $0.offset < $1.offset }
            .map { $0.element }
        var result: [(Int, Int)] = []
        for r in ranges {
            if let last = result.last, r.0 < last.1 {
                result[result.count - 1] = (last.0, r.1)
            } else {
                result.append(r)
            }
        }
        return result
    }

    /// homr find_peaks.find_peaks(x, height, distance, prominence). The distance step's height sort uses a
    /// stable sort (numpy's argsort is unstable/platform dependent for ties).
    static func findPeaks(_ x: [Double], height: Double, distance: Double, prominence: Double) -> [Int] {
        let n = x.count
        if n < 3 { return [] }
        var peaks: [Int] = []
        var i = 1
        while i < n - 1 {
            if x[i] > x[i - 1] {
                var j = i
                while j < n - 1 && x[j] == x[j + 1] { j += 1 }
                if j < n - 1 && x[j] > x[j + 1] { peaks.append((i + j) / 2) }
                i = j + 1
            } else if x[i] == x[i - 1] {
                var j = i
                while j < n - 1 && x[j] == x[j + 1] { j += 1 }
                if j < n - 1 && x[j] > x[j + 1] { peaks.append((i + j) / 2) }
                i = j + 1
            } else {
                i += 1
            }
        }
        peaks = peaks.filter { x[$0] >= height }
        peaks = peaks.filter { p in
            var leftMin = x[p]
            var k = p - 1
            while k >= 0 { if x[k] > x[p] { break }; leftMin = min(leftMin, x[k]); k -= 1 }
            var rightMin = x[p]
            k = p + 1
            while k < n { if x[k] > x[p] { break }; rightMin = min(rightMin, x[k]); k += 1 }
            return x[p] - max(leftMin, rightMin) >= prominence
        }
        if peaks.count > 1 {
            let asc = peaks.enumerated().sorted { x[$0.element] != x[$1.element] ? x[$0.element] < x[$1.element] : $0.offset < $1.offset }
            var keep: [Int] = []
            for (_, p) in asc.reversed() where keep.allSatisfy({ Double(abs($0 - p)) >= distance }) {
                keep.append(p)
            }
            peaks = keep.sorted()
        }
        return peaks
    }

    static func filterLinePeaks(_ peaks: [Int], _ norm: [Double]) -> [Int] {
        guard let first = peaks.first else { return [] }
        let gaps = NP.diff(peaks.map(Double.init))
        let count = max(5, NP.round(Double(peaks.count) * 0.2))
        let approx = NP.mean(Array(gaps.sorted().prefix(count)))
        let maxGap = approx * 1.5
        let ext = [Double(first) - maxGap - 1] + peaks.map(Double.init)
        var groups: [Int] = []
        var g = -1
        for i in 1..<ext.count {
            if ext[i] - ext[i - 1] > maxGap { g += 1 }
            groups.append(g)
        }
        return groups
    }

    static func findHorizontalLines(_ img: [UInt8], width: Int, height: Int, x0: Int, x1: Int,
                                    unitSize: Double) -> [[Int]] {
        var count = [Double](repeating: 0, count: height + 2)
        for y in 0..<height {
            var c = 0
            let base = y * width
            for x in x0..<x1 where img[base + x] > 0 { c += 1 }
            count[y + 1] = Double(c)
        }
        let m = NP.mean(count), sd = NP.std(count)
        let norm = count.map { ($0 - m) / sd }
        let centers = findPeaks(norm, height: 0, distance: 0.7 * unitSize, prominence: 1).map { $0 - 1 }
        let inner = Array(norm[1..<(norm.count - 1)])
        let groups = filterLinePeaks(centers, inner)
        var order: [Int] = []
        var grouped: [Int: [Int]] = [:]
        for (i, c) in centers.enumerated() {
            let gn = groups[i]
            if grouped[gn] == nil { order.append(gn); grouped[gn] = [] }
            grouped[gn]!.append(c)
        }
        return order.compactMap { grouped[$0]!.count == 5 ? grouped[$0]!.sorted() : nil }
    }

    static func predictOtherAnchorsFromClefs(_ clefAnchors: [StaffAnchor], _ img: [UInt8], width: Int,
                                             height: Int) -> [HBox] {
        if clefAnchors.isEmpty { return [] }
        let unit = NP.mean(clefAnchors.map { $0.averageUnitSize })
        let symbols = clefAnchors.map { $0.symbol }
        var result: [HBox] = []
        for zone in initZone(clefAnchors, width: width) where zone.1 > zone.0 {
            for group in findHorizontalLines(img, width: width, height: height, x0: zone.0, x1: zone.1, unitSize: unit) {
                let minY = group.min()!, maxY = group.max()!
                let centerY = Double(minY + maxY) / 2
                let centerX = Double(zone.0) + Double(zone.1 - zone.0) / 2
                let raw: HBox.Raw = (Double(Int(centerX)), Double(Int(centerY)), Double(zone.1 - zone.0),
                                     Double(maxY - minY), 0)
                result.append(.rotated(raw, contour: []))
            }
        }
        return result.filter { !$0.isOverlappingWithAny(symbols) }
    }

    // MARK: break_wide_fragments

    static func breakWideFragments(_ fragments: [HBox], limit: Double = 100) -> [HBox] {
        var result: [HBox] = []
        for f in fragments {
            var rem = f
            while rem.w > limit {
                let minX = rem.contour.map { $0.x }.min()!
                let lim = Double(minX) + limit
                var left = rem.contour.filter { Double($0.x) < lim }
                var right = rem.contour.filter { Double($0.x) >= lim }
                left = stableSortByX(left)
                right = stableSortByX(right)
                if left.isEmpty || right.isEmpty { break }
                left.append(right[0])
                right.append(left[left.count - 1])
                result.append(.rotated(HBox.raw(CVShapes.minAreaRect(left)), contour: left))
                rem = .rotated(HBox.raw(CVShapes.minAreaRect(right)), contour: right)
            }
            result.append(rem)
        }
        return result
    }

    private static func stableSortByX(_ p: [Point]) -> [Point] {
        p.enumerated().sorted { $0.element.x != $1.element.x ? $0.element.x < $1.element.x : $0.offset < $1.offset }
            .map { $0.element }
    }

    // MARK: detect_staff

    static func detectStaff(image: [UInt8], width: Int, height: Int, fragments: [HBox], clefsKeys: [HBox],
                            barLines: [HBox]) -> [HStaff] {
        var anchors = findStaffAnchors(fragments, clefsKeys, areClefs: true)
        let others = predictOtherAnchorsFromClefs(anchors, image, width: width, height: height)
        anchors += findStaffAnchors(fragments, others, areClefs: true)
        anchors += findStaffAnchors(fragments, barLines, areClefs: false)
        anchors = filterUnusualAnchors(anchors)
        let raw = removeDuplicateStaffs(findRawStaffs(anchors, fragments))
        let staffs = raw.compactMap { resampleStaff($0) }
        let kept = filterEdgeOfVision(staffs, width: width, height: height)
        return kept.enumerated().sorted { $0.element.minY != $1.element.minY ? $0.element.minY < $1.element.minY : $0.offset < $1.offset }
            .map { $0.element }
    }
}
