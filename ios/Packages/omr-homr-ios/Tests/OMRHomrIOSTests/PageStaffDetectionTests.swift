// SPDX-License-Identifier: AGPL-3.0-or-later
//
// omr-sheet-cam — page staff detection (milestone 2) vs fixtures/oracle.pages stages.json.
// Port of liebharc/homr @ 7d97c3cee4ad772b50266fdf9dc78bbf9064701e (AGPL-3.0): checks the Swift port of
// homr/staff_detection.py + brace_dot_detection.py against homr's own intermediate outputs.
import Foundation
import XCTest
@testable import OMRHomrIOS

final class PageStaffDetectionTests: XCTestCase {
    private struct Stages: Decodable {
        struct Geometry: Decodable { var grid: [StaffGeometry.Point]; var regions: [[Double]] }
        struct Input: Decodable { var geometry: Geometry; var is_grandstaff: Bool }
        var average_note_head_height: Double
        var ensured_rows: [Int]
        var staff_inputs: [Input]
        struct Symbols: Decodable { var noteheads: [[Double]] }
        var symbols: Symbols
    }

    private func check(_ fid: String, staffs: Int, grandstaff: Bool) throws {
        let dir = try WriterOnlyFixtureTests.fixturesRoot().appendingPathComponent("oracle.pages/\(fid)")
        let seg = try PagePipeline.decodeGrayPNG(Data(contentsOf: dir.appendingPathComponent("segnet.png")))
        let ref = try JSONDecoder().decode(Stages.self, from: Data(contentsOf: dir.appendingPathComponent("stages.json")))
        let got = try PagePipeline.detectStaffs(segmentation: seg.pixels, width: seg.width, height: seg.height)

        XCTAssertEqual(got.averageNoteHeadHeight, ref.average_note_head_height)
        XCTAssertEqual(got.ensuredRows, ref.ensured_rows)
        XCTAssertEqual(got.symbols["noteheads"], ref.symbols.noteheads)
        XCTAssertEqual(got.staffs.count, staffs)
        XCTAssertEqual(got.staffs.count, ref.staff_inputs.count)
        for (g, r) in zip(got.staffs, ref.staff_inputs) {
            XCTAssertEqual(g.isGrandstaff, r.is_grandstaff)
            XCTAssertEqual(g.isGrandstaff, grandstaff)
            XCTAssertEqual(g.geometry.regions, r.geometry.regions)
            XCTAssertEqual(g.geometry.grid.count, r.geometry.grid.count)
            for (a, b) in zip(g.geometry.grid, r.geometry.grid) {
                XCTAssertEqual(a.x, b.x)
                XCTAssertEqual(a.y, b.y)
            }
        }
    }

    // One page only: the debug build takes ~20 s per page. All 9 pages are checked (release) by
    // `omr-test detect-staffs fixtures/oracle.pages/<id>`.
    /// Grand staff merging (brace detection) + > 127 contour labels in cv2 tree mode (Int8 nbd wrap).
    func testPianoGrandStaff() throws {
        try check("piano.grand", staffs: 1, grandstaff: true)
    }

    private func staff(top: Double, grand: Bool) -> HStaff {
        let lines = grand ? 10 : 5
        let ys = (0..<lines).map { top + Double($0) * 10 + ($0 >= 5 ? 40 : 0) }
        let s = HStaff(grid: [HStaffPoint(x: 100, y: ys, angle: 0), HStaffPoint(x: 1800, y: ys, angle: 0)])!
        s.isGrandstaff = grand
        return s
    }

    /// Scan "Sweden": 4 piano systems; brace detection returned rows [[sys1, sys2], [sys3, sys4]] (each a
    /// grand staff), so sys1 and sys2 became two voices that both start at tick 0. Must become 4 rows of
    /// one grand staff each, top to bottom.
    func testStackedGrandStaffSystemsSplitIntoSequentialRows() {
        let s = [0.0, 300, 600, 900].map { staff(top: $0, grand: true) }
        let rows = BraceDetection.splitStackedGrandStaffSystems([HMultiStaff([s[0], s[1]], []), HMultiStaff([s[2], s[3]], [])])
        XCTAssertEqual(rows.map { $0.staffs.count }, [1, 1, 1, 1])
        XCTAssertTrue(zip(rows.map { $0.staffs[0] }, s).allSatisfy { $0 === $1 })
    }

    /// Voice + piano (single staff above a grand staff) is a real 2-voice ensemble: unchanged.
    func testVoiceAndPianoRowsKept() {
        let rows = [HMultiStaff([staff(top: 0, grand: false), staff(top: 100, grand: true)], []),
                    HMultiStaff([staff(top: 500, grand: false), staff(top: 600, grand: true)], [])]
        XCTAssertEqual(BraceDetection.splitStackedGrandStaffSystems(rows).map { $0.staffs.count }, [2, 2])
    }
}
