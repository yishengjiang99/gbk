// SPDX-License-Identifier: AGPL-3.0-or-later
// omr-sheet-cam — compares the Swift port of homr's staff detection with an oracle stages.json
// (tools/oracle/export_page_pipeline.py). Port of liebharc/homr @ 7d97c3cee4ad772b50266fdf9dc78bbf9064701e
// (AGPL-3.0): checks against the outputs of homr's own functions.
// (JSONDecoder, not JSONSerialization: corelibs JSONSerialization does not round-trip doubles exactly.)
import Foundation
import OMRHomrIOS

enum StaffLayoutCompare {
    struct Report { var ok: Bool; var lines: [String] }

    struct Stages: Decodable {
        struct GridPoint: Decodable { var x: Double; var y: [Double]; var angle: Double }
        struct StaffJ: Decodable {
            var grid: [GridPoint]
            var min_x: Double, max_x: Double, min_y: Double, max_y: Double
            var average_unit_size: Double
            var is_grandstaff: Bool
        }
        struct Geometry: Decodable { var grid: [GridPoint]; var regions: [[Double]] }
        struct Input: Decodable { var index: Int; var geometry: Geometry; var is_grandstaff: Bool }
        var symbols: [String: AnyBoxes]
        var average_note_head_height: Double
        var staffs: [StaffJ]
        var multi_staffs: [[StaffJ]]
        var ensured_rows: [Int]
        var staff_inputs: [Input]
    }

    /// `symbols` values are box lists except `noteheads_with_stems` (objects): decode leniently.
    struct AnyBoxes: Decodable {
        var boxes: [[Double]]
        init(from decoder: Decoder) throws {
            boxes = (try? decoder.singleValueContainer().decode([[Double]].self)) ?? []
        }
    }

    static func load(_ url: URL) throws -> Stages {
        try JSONDecoder().decode(Stages.self, from: Data(contentsOf: url))
    }

    static func compareBoxes(_ name: String, _ got: [[Double]], _ want: [[Double]]) -> (Bool, String) {
        if got.count != want.count {
            return (false, "symbols.\(name): count \(got.count) vs homr \(want.count)")
        }
        var bad = 0
        var first = ""
        for (i, (g, w)) in zip(got, want).enumerated() where g != w {
            if bad == 0 { first = " first #\(i): \(g) vs \(w)" }
            bad += 1
        }
        return (bad == 0, "symbols.\(name): \(got.count) boxes, \(bad) differ\(first)")
    }

    static func gridEqual(_ g: [StaffGeometry.Point], _ want: [Stages.GridPoint]) -> String? {
        if g.count != want.count { return "grid points \(g.count) vs \(want.count)" }
        for (i, (p, w)) in zip(g, want).enumerated() where p.x != w.x || p.y != w.y || (p.angle ?? .nan) != w.angle {
            return "grid[\(i)] x \(p.x) y \(p.y) a \(p.angle ?? .nan) vs x \(w.x) y \(w.y) a \(w.angle)"
        }
        return nil
    }

    static func staffInfoLine(_ label: String, _ s: PageStaffLayout.StaffInfo, _ w: Stages.StaffJ) -> (Bool, String) {
        var problems: [String] = []
        if let e = gridEqual(s.grid, w.grid) { problems.append(e) }
        let keys: [(String, Double, Double)] = [("min_x", s.minX, w.min_x), ("max_x", s.maxX, w.max_x),
                                                ("min_y", s.minY, w.min_y), ("max_y", s.maxY, w.max_y),
                                                ("average_unit_size", s.averageUnitSize, w.average_unit_size)]
        for (k, v, e) in keys where v != e { problems.append("\(k) \(v) vs \(e)") }
        if w.is_grandstaff != s.isGrandstaff { problems.append("is_grandstaff \(s.isGrandstaff)") }
        return (problems.isEmpty, "\(label): \(s.grid.count) grid points, unit \(String(format: "%.4f", s.averageUnitSize))"
                + (problems.isEmpty ? " identical" : " DIFF " + problems.joined(separator: "; ")))
    }

    static func compare(_ layout: PageStaffLayout, _ st: Stages) -> Report {
        var ok = true
        var lines: [String] = []
        for key in ["noteheads", "staff_fragments_raw", "clefs_keys", "stems_rest", "bar_lines_raw", "staff_fragments",
                    "bar_lines_or_rests", "bar_line_boxes", "brace_dot"] {
            let (g, l) = compareBoxes(key, layout.symbols[key] ?? [], st.symbols[key]?.boxes ?? [])
            ok = ok && g
            lines.append(l)
        }
        if st.average_note_head_height != layout.averageNoteHeadHeight { ok = false }
        lines.append("average_note_head_height: \(layout.averageNoteHeadHeight) vs \(st.average_note_head_height)")
        if st.staffs.count != layout.detectedStaffs.count { ok = false }
        lines.append("staffs: \(layout.detectedStaffs.count) vs homr \(st.staffs.count)")
        for (i, (s, w)) in zip(layout.detectedStaffs, st.staffs).enumerated() {
            let (g, l) = staffInfoLine("  staff[\(i)]", s, w)
            ok = ok && g
            lines.append(l)
        }
        let rowsGot = layout.multiStaffs.map { $0.count }, rowsWant = st.multi_staffs.map { $0.count }
        if rowsGot != rowsWant { ok = false }
        lines.append("multi_staff_rows: \(rowsGot) vs homr \(rowsWant)")
        for (i, (m, w)) in zip(layout.multiStaffs, st.multi_staffs).enumerated() {
            for (j, (s, ws)) in zip(m, w).enumerated() {
                let (g, l) = staffInfoLine("  multi[\(i)][\(j)]", s, ws)
                ok = ok && g
                lines.append(l)
            }
        }
        if st.ensured_rows != layout.ensuredRows { ok = false }
        lines.append("ensured_rows: \(layout.ensuredRows) vs homr \(st.ensured_rows)")
        if st.staff_inputs.count != layout.staffs.count { ok = false }
        lines.append("staff_inputs: \(layout.staffs.count) vs homr \(st.staff_inputs.count)")
        for (i, (s, w)) in zip(layout.staffs, st.staff_inputs).enumerated() {
            var problems: [String] = []
            if let e = gridEqual(s.geometry.grid, w.geometry.grid) { problems.append(e) }
            if w.geometry.regions != s.geometry.regions { problems.append("regions \(s.geometry.regions) vs \(w.geometry.regions)") }
            if w.is_grandstaff != s.isGrandstaff { problems.append("is_grandstaff") }
            ok = ok && problems.isEmpty
            lines.append("  staff_input[\(i)] voice \(s.voice) row \(s.row) grandstaff \(s.isGrandstaff): "
                         + (problems.isEmpty ? "geometry identical" : "DIFF " + problems.joined(separator: "; ")))
        }
        return Report(ok: ok, lines: lines)
    }
}
