// SPDX-License-Identifier: AGPL-3.0-or-later
//
// omr-sheet-cam — homr brace / grand-staff grouping (page pipeline, milestone 2).
// Port of liebharc/homr @ 7d97c3cee4ad772b50266fdf9dc78bbf9064701e (AGPL-3.0): homr/brace_dot_detection.py
// (prepare_brace_dot_image, _trim_symbol_to_core_span, _filter_for_tall_elements, connections,
// find_braces_brackets_and_grand_staff_lines), MultiStaff from homr/model.py, and
// _ensure_same_number_of_staffs / _find_periodic_core / StaffRegions from homr/staff_parsing.py and
// homr/staff_regions.py. Bar-line and clef connections are not ported: at this point homr's staffs only
// hold notes (add_notes_to_staffs), so get_bar_lines() / get_clefs() are always empty.

import Foundation

/// homr `MultiStaff` (staffs sorted by min_y).
struct HMultiStaff {
    var staffs: [HStaff]
    var connections: [HBox]

    init(_ staffs: [HStaff], _ connections: [HBox]) {
        self.staffs = staffs.enumerated().sorted {
            $0.element.minY != $1.element.minY ? $0.element.minY < $1.element.minY : $0.offset < $1.offset
        }.map { $0.element }
        self.connections = connections
    }

    func merge(_ o: HMultiStaff) -> HMultiStaff {
        var us: [HStaff] = []
        var uc: [HBox] = []
        for s in staffs + o.staffs where !us.contains(where: { $0 === s }) { us.append(s) }
        for c in connections + o.connections where !uc.contains(c) { uc.append(c) }
        return HMultiStaff(us, uc)
    }

    func scoreBrace(_ symbol: HBox, _ upper: HStaff, _ lower: HStaff, above: HStaff?, below: HStaff?) -> Double {
        let unit = (upper.averageUnitSize + lower.averageUnitSize) / 2
        let xThreshold = 5 * unit
        let yThreshold = 0.5 * symbol.h
        let symMinY = symbol.cy - symbol.h / 2
        let symMaxY = symbol.cy + symbol.h / 2
        if let a = above, symMinY < (a.maxY + upper.minY) / 2 { return 0 }
        if let b = below, symMaxY > (lower.maxY + b.minY) / 2 { return 0 }
        let symX = symbol.cx
        let xDistance = min(abs(upper.minX - symX), abs(lower.minX - symX))
        let yOverlap = min(symMaxY, lower.maxY) - max(symMinY, upper.minY)
        if !(xDistance < xThreshold && yOverlap > yThreshold && yOverlap > xDistance) { return 0 }
        let union = max(symMaxY, lower.maxY) - min(symMinY, upper.minY)
        let iou = union > 0 ? yOverlap / union : 0.0
        return iou - xDistance / xThreshold
    }

    func createGrandstaffs(_ braceDot: [HBox]) -> HMultiStaff {
        if staffs.count < 2 || braceDot.isEmpty { return self }
        var pairs: [(idx: Int, score: Double)] = []
        for i in 0..<(staffs.count - 1) {
            let above = i > 0 ? staffs[i - 1] : nil
            let below = i + 2 < staffs.count ? staffs[i + 2] : nil
            let best = braceDot.map { scoreBrace($0, staffs[i], staffs[i + 1], above: above, below: below) }.max()!
            if best > 0 { pairs.append((i, best)) }
        }
        let sortedPairs = pairs.enumerated().sorted {
            $0.element.score != $1.element.score ? $0.element.score > $1.element.score : $0.offset < $1.offset
        }.map { $0.element }
        var used = Set<Int>()
        var selected: [Int] = []
        for p in sortedPairs where !used.contains(p.idx) && !used.contains(p.idx + 1) {
            selected.append(p.idx)
            used.insert(p.idx); used.insert(p.idx + 1)
        }
        if selected.isEmpty { return self }
        var merged: [HStaff] = []
        var i = 0
        while i < staffs.count {
            if selected.contains(where: { $0 == i || $0 + 1 == i }), i + 1 < staffs.count,
               let m = staffs[i].merge(staffs[i + 1]) {
                merged.append(m)
                i += 2
                continue
            }
            merged.append(staffs[i])
            i += 1
        }
        return HMultiStaff(merged, connections)
    }
}

enum BraceDetection {
    typealias Point = CVContours.Point

    /// prepare_brace_dot_image: subtract (saturating) then ellipse erode (1, 5) and dilate (5, 35).
    static func braceDotImage(symbols: [UInt8], staff: [UInt8], width: Int, height: Int) -> [UInt8] {
        var d = [UInt8](repeating: 0, count: symbols.count)
        for i in 0..<symbols.count where symbols[i] > staff[i] { d[i] = symbols[i] - staff[i] }
        let e = CVShapes.morph(d, width: width, height: height, kernel: CVShapes.ellipseKernel(kw: 1, kh: 5), kw: 1, erode: true)
        return CVShapes.morph(e, width: width, height: height, kernel: CVShapes.ellipseKernel(kw: 5, kh: 35), kw: 5, erode: false)
    }

    static func trimToCoreSpan(_ s: HBox) -> HBox {
        let br = CVContours.boundingRect(s.contour)
        if br.height <= 0 || br.width <= 0 { return s }
        let shifted = s.contour.map { Point(x: $0.x - br.x, y: $0.y - br.y) }
        let rows = CVShapes.filledRowWidths(shifted, width: br.width, height: br.height)
        let maxW = rows.max() ?? 0
        if maxW == 0 { return s }
        let limit = Double(maxW) * 0.5
        let core = rows.indices.filter { Double(rows[$0]) >= limit }
        guard let lo = core.first, let hi = core.last else { return s }
        let minY = br.y + lo, maxY = br.y + hi + 1
        let hgt = maxY - minY
        if hgt <= 0 { return s }
        return .rotated((s.cx, Double(minY + maxY) / 2, s.w, Double(hgt), s.angle), contour: s.contour)
    }

    static func filterTall(_ braceDot: [HBox], _ staffs: [HStaff]) -> [HBox] {
        guard let first = staffs.first else { return [] }
        let rough = first.averageUnitSize
        let candidates = braceDot.filter { $0.h > 2 * rough && $0.w < 3 * rough && $0.w >= 5 }
        return candidates.filter { s in
            var best = staffs[0]
            var bd = best.yDistanceTo((s.cx, s.cy))
            for st in staffs.dropFirst() {
                let d = st.yDistanceTo((s.cx, s.cy))
                if d < bd { bd = d; best = st }
            }
            return s.h > 4 * best.averageUnitSize
        }
    }

    static func connectionsAtLines(_ a: HStaff, _ b: HStaff, _ braceDot: [HBox]) -> [HBox] {
        var result: [HBox] = []
        for s in braceDot {
            let thick = s.makeThicker(Double(NP.round(a.averageUnitSize * 2)))
            guard let p1 = a.getAt(s.cx), let p2 = b.getAt(s.cx) else { continue }
            if thick.isOverlapping(p1.toBoundingBox()) && thick.isOverlapping(p2.toBoundingBox()) {
                result.append(s)
            }
        }
        return result
    }

    static func findBracesAndGrandStaffs(_ staffs: [HStaff], _ braceDotIn: [HBox]) -> (multi: [HMultiStaff], braceDot: [HBox]) {
        let braceDot = filterTall(braceDotIn.map { trimToCoreSpan($0) }, staffs)
        var result: [HMultiStaff] = []
        for (i, s) in staffs.enumerated() {
            var neighbors: [HStaff] = []
            if i > 0 { neighbors.append(staffs[i - 1]) }
            if i < staffs.count - 1 { neighbors.append(staffs[i + 1]) }
            var any = false
            for nb in neighbors {
                let c = connectionsAtLines(s, nb, braceDot)
                if c.count >= 1 {
                    result.append(HMultiStaff([s, nb], c))
                    any = true
                }
            }
            if !any { result.append(HMultiStaff([s], [])) }
        }
        var merged: [HMultiStaff] = []
        for m in result {
            var done = false
            for (k, e) in merged.enumerated() where e.staffs.contains(where: { x in m.staffs.contains { $0 === x } }) {
                merged.remove(at: k)
                merged.append(e.merge(m))
                done = true
                break
            }
            if !done { merged.append(m) }
        }
        return (merged.map { $0.createGrandstaffs(braceDot) }, braceDot)
    }

    // MARK: staff_parsing._ensure_same_number_of_staffs

    static func findPeriodicCore(_ flat: [HStaff]) -> (period: Int, front: Int, back: Int)? {
        let layout = flat.map { $0.isGrandstaff }
        let n = layout.count
        var best: (Int, Int, Int, Int)?
        if n < 2 { return nil }
        for period in 1...(n / 2) {
            for front in 0...period {
                for back in 0...period {
                    let lo = front, hi = n - back
                    if hi < lo { continue }
                    let core = Array(layout[lo..<hi])
                    if core.count < 2 * period || core.count % period != 0 { continue }
                    let first = Array(core[0..<period])
                    var ok = true
                    var i = 0
                    while i < core.count { if Array(core[i..<(i + period)]) != first { ok = false; break }; i += period }
                    if !ok { continue }
                    let cand = (front + back, period, front, back)
                    if let b = best {
                        if cand.0 < b.0 || (cand.0 == b.0 && cand.1 < b.1) { best = cand }
                    } else {
                        best = cand
                    }
                }
            }
        }
        guard let b = best else { return nil }
        return (b.1, b.2, b.3)
    }

    /// Not in homr. A grand staff (treble + bass already merged by `createGrandstaffs`) is a complete
    /// piano system, so a row holding two or more of them means brace / bar-line connections chained
    /// *consecutive systems* into one multi-staff (e.g. systems 1+2 and 3+4 of a 4-system page). homr
    /// would then decode each grand staff as its own voice, and every voice starts at tick 0 — two
    /// systems play at once. When every staff on the page is a grand staff, put each one in its own
    /// row (top to bottom) so the page becomes one grand-staff voice whose systems play in sequence.
    /// Rows mixing a single staff with a grand staff (voice + piano) are real ensembles and are kept.
    static func splitStackedGrandStaffSystems(_ rows: [HMultiStaff]) -> [HMultiStaff] {
        let all = rows.flatMap { $0.staffs }
        guard !all.isEmpty, all.allSatisfy(\.isGrandstaff), rows.contains(where: { $0.staffs.count > 1 }) else {
            return rows
        }
        return all.enumerated().sorted {
            $0.element.minY != $1.element.minY ? $0.element.minY < $1.element.minY : $0.offset < $1.offset
        }.map { HMultiStaff([$0.element], []) }
    }

    static func ensureSameNumberOfStaffs(_ multi: [HMultiStaff]) -> [HMultiStaff] {
        let lengths = Set(multi.map { $0.staffs.count })
        if lengths.count == 1, let l = lengths.first, l > 1 { return multi }
        let flat = multi.flatMap { $0.staffs }
        if let core = findPeriodicCore(flat) {
            let c = Array(flat[core.front..<(flat.count - core.back)])
            return stride(from: 0, to: c.count, by: core.period).map {
                HMultiStaff(Array(c[$0..<min($0 + core.period, c.count)]), [])
            }
        }
        let broken = multi.flatMap { m in m.staffs.map { HMultiStaff([$0], []) } }
        return broken.enumerated().sorted {
            $0.element.staffs[0].minY != $1.element.staffs[0].minY ? $0.element.staffs[0].minY < $1.element.staffs[0].minY
                : $0.offset < $1.offset
        }.map { $0.element }
    }
}
