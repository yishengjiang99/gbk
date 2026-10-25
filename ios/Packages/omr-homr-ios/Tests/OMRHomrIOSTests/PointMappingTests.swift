// SPDX-License-Identifier: AGPL-3.0-or-later
// Tests for the homr dda4d2f point mapping port (Page/PointMapping.swift).
import XCTest
@testable import OMRHomrIOS

final class PointMappingTests: XCTestCase {
    /// homr tests/test_point_mapping.py: chain(undo_resize((200, 400), (100, 800)), undo_crop(100, 50))
    /// with numpy (h, w) shapes maps (80, 30) to (140, 110).
    func testUndoResizeThenCropMatchesHomr() {
        // numpy shape (200, 400) -> (w 400, h 200); (100, 800) -> (w 800, h 100)
        let r = PointMapping.undoResize(PagePoint(x: 80, y: 30), before: (w: 400, h: 200), after: (w: 800, h: 100))
        let p = PointMapping.undoCrop(r, x: 100, y: 50)
        XCTAssertEqual(p.x, 140, accuracy: 1e-9)
        XCTAssertEqual(p.y, 110, accuracy: 1e-9)
    }

    func testInverseAffineRoundTrip() throws {
        typealias P = CVGeometry.Point2f
        var src: [P] = [], dst: [P] = []
        for gy in 0...3 {
            for gx in 0...4 {
                let x = Float(gx * 50), y = Float(gy * 40)
                src.append(P(x: x, y: y))
                // Smooth warp, like a dewarped staff: vertical bend + slight horizontal stretch.
                dst.append(P(x: x * 1.05 + 2, y: y + 6 * sin(x / 60)))
            }
        }
        let pa = try StaffPrepare.PiecewiseAffine(src: src, dst: dst)
        for (x, y) in [(10.0, 10.0), (73.0, 55.0), (180.0, 100.0), (120.5, 33.25)] {
            let q = pa.forwardTransform(PagePoint(x: x, y: y))
            let back = pa.inverseTransform(q)
            XCTAssertEqual(back.x, x, accuracy: 1e-3, "x at \(x),\(y)")
            XCTAssertEqual(back.y, y, accuracy: 1e-3, "y at \(x),\(y)")
        }
        // Outside the mesh the point is returned unchanged (homr inverse_transform_point).
        let far = PagePoint(x: -500, y: -500)
        XCTAssertEqual(pa.inverseTransform(far), far)
    }

    func testInvertAffine() throws {
        let m = [2.0, 0.5, 10, -0.25, 3, -4]
        let inv = try XCTUnwrap(StaffPrepare.PiecewiseAffine.invertAffine(m))
        let p = (x: 7.0, y: -3.0)
        let q = (x: m[0] * p.x + m[1] * p.y + m[2], y: m[3] * p.x + m[4] * p.y + m[5])
        XCTAssertEqual(inv[0] * q.x + inv[1] * q.y + inv[2], p.x, accuracy: 1e-9)
        XCTAssertEqual(inv[3] * q.x + inv[4] * q.y + inv[5], p.y, accuracy: 1e-9)
        XCTAssertNil(StaffPrepare.PiecewiseAffine.invertAffine([1, 2, 0, 2, 4, 0]))
    }

    func testPageToInputUndoesAutocropAndResize() {
        let m = PageToInputMapping(crop: .init(x: 100, y: 40, width: 1000, height: 1400), pageWidth: 2000, pageHeight: 2800)
        let p = m.toInput(PagePoint(x: 500, y: 700))
        XCTAssertEqual(p.x, 350, accuracy: 1e-9)
        XCTAssertEqual(p.y, 390, accuracy: 1e-9)
        XCTAssertEqual(m.scale.x, 0.5, accuracy: 1e-12)
    }

    func testNoteBoxSnapsToNearestNotehead() {
        let m = PageToInputMapping(crop: .init(x: 0, y: 0, width: 100, height: 100), pageWidth: 200, pageHeight: 200)
        let prov = AttentionNoteBoxProvider(
            noteheads: [[50, 50, 14, 10, 0], [90, 52, 12, 12, 0], [400, 400, 12, 12, 0]], noteheadHeight: 12, toInput: m)
        let snapped = prov.pageBox(around: PagePoint(x: 55, y: 48))
        XCTAssertTrue(snapped.snapped)
        XCTAssertEqual(snapped.x + snapped.w / 2, 50, accuracy: 1e-9)
        XCTAssertEqual(snapped.w, 14, accuracy: 1e-9)
        let free = prov.pageBox(around: PagePoint(x: 250, y: 250)) // 2.5*12 = 30 px radius: no notehead near
        XCTAssertFalse(free.snapped)
        XCTAssertEqual(free.x + free.w / 2, 250, accuracy: 1e-9)
    }

    /// SegNet often merges a chord's noteheads into one tall blob: each note keeps its own row.
    func testChordBlobKeepsEachNotesRow() {
        let m = PageToInputMapping(crop: .init(x: 0, y: 0, width: 100, height: 100), pageWidth: 100, pageHeight: 100)
        let prov = AttentionNoteBoxProvider(noteheads: [[200, 250, 12, 40, 0]], noteheadHeight: 40, toInput: m)
        let ys = [232.0, 249.0, 264.0].map { prov.pageBox(around: PagePoint(x: 203, y: $0)) }
        XCTAssertEqual(ys.map { $0.x + $0.w / 2 }, [200, 200, 200])
        XCTAssertEqual(ys.map { $0.y + $0.h / 2 }, [232, 249, 264])
        XCTAssertTrue(ys.allSatisfy { $0.w < 15 })
    }

    func testAttentionCenterDecodesFloat32PairAndSkipsChords() {
        func payload(_ a: Float, _ b: Float) -> Data {
            var d = Data()
            for v in [a, b] { withUnsafeBytes(of: v.bitPattern.littleEndian) { d.append(contentsOf: $0) } }
            return d
        }
        var s = EncodedSymbol(rhythm: "note_4", pitch: "C4", lift: "_", articulation: "_", position: "upper")
        s.attentionPayload = payload(320.5, 128)
        XCTAssertEqual(s.attentionCenter, PagePoint(x: 320.5, y: 128))
        var c = EncodedSymbol(rhythm: "chord", pitch: ".", lift: ".", articulation: ".", position: ".")
        c.attentionPayload = payload(1, 2)
        XCTAssertNil(c.attentionCenter)
        s.attentionPayload = payload(.nan, 1)
        XCTAssertNil(s.attentionCenter)
    }
}
