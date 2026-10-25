import XCTest
import OMRPNG
@testable import OMRHomrIOS

/// Preprocessing gate: homr staff preprocessing ported to Swift (`StaffTensor.fromStaffImage`) must
/// reproduce `fixtures/oracle.c_scale_staff/staff.npy` from `staff.png` within one gray level, and the
/// OpenCV primitives it uses must match cv2 references (`tools/oracle/export_preprocess_refs.py`).
final class StaffPreprocessingTests: XCTestCase {
    static var cv2Refs: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("Fixtures/staff_preprocess_cv2")
    }

    static func oracleDir() throws -> URL {
        try WriterOnlyFixtureTests.fixturesRoot().appendingPathComponent("oracle.c_scale_staff")
    }

    // MARK: gate

    func testStaffPNGMatchesOracleNPYWithinOneGrayLevel() throws {
        let dir = try Self.oracleDir()
        let png = try PNGDecoder.decode(contentsOf: dir.appendingPathComponent("staff.png"))
        XCTAssertEqual([png.width, png.height, png.channels], [1280, 256, 1])
        let got = try StaffTensor.fromStaffImage(grayscale: png.grayscale(), width: png.width, height: png.height)
        let want = try StaffTensor.loadNPY(dir.appendingPathComponent("staff.npy"))
        XCTAssertEqual(got.shape, [1, 1, 256, 1280])
        let d = StaffTensorDiff(got, want)
        XCTAssertTrue(d.withinOneGrayLevel, "max_abs_diff \(d.maxAbs) > \(StaffTensorDiff.oneGrayLevel)")
        // Regression guard: today the port is bit-exact (identity resize + float64 ConvertToArray).
        XCTAssertEqual(d.maxAbs, 0, "mean \(d.meanAbs), >1e-3: \(d.countAbove1e3)")
    }

    func testToleranceIsExactlyOneGrayLevel() throws {
        let tol = StaffTensorDiff.oneGrayLevel
        XCTAssertEqual(tol, 1.0 / (255.0 * 0.1738), accuracy: 1e-6)
        XCTAssertGreaterThanOrEqual(tol, 1.0 / (255.0 * 0.1738))
        // A canvas off by one gray level everywhere passes; two gray levels in one pixel fails.
        let base = [UInt8](repeating: 128, count: 256 * 1280)
        var one = base.map { $0 &+ 1 }
        let t0 = try StaffTensor.fromCanvas(base)
        XCTAssertTrue(StaffTensorDiff(try StaffTensor.fromCanvas(one), t0).withinOneGrayLevel)
        one = base
        one[12345] = 130
        let d2 = StaffTensorDiff(try StaffTensor.fromCanvas(one), t0)
        XCTAssertFalse(d2.withinOneGrayLevel)
        XCTAssertEqual(d2.countAbove1e3, 1)
        // Every adjacent pair of gray levels is within tolerance (fp32 rounding included).
        let table = StaffPreprocessing.normalizationTable
        for p in 1..<256 { XCTAssertLessThanOrEqual(Double(table[p]) - Double(table[p - 1]), tol) }
    }

    func testNormalizationMatchesConvertToArray() {
        let t = StaffPreprocessing.normalizationTable
        XCTAssertEqual(t[0], Float((0.0 - 0.7931) / 0.1738))
        XCTAssertEqual(t[255], Float((1.0 - 0.7931) / 0.1738))
        let g200: Double = 200.0 / 255.0
        XCTAssertEqual(t[200], Float((g200 - 0.7931) / 0.1738))
    }

    // MARK: homr canvas geometry

    func testCanvasSizeMatchesHomr() {
        // get_tr_omr_canvas_size: ratio 256/1280 = 0.2; int() truncation.
        XCTAssertTrue(StaffPreprocessing.canvasSize(width: 1280, height: 256) == (1280, 256))
        XCTAssertTrue(StaffPreprocessing.canvasSize(width: 509, height: 181) == (719, 256))
        XCTAssertTrue(StaffPreprocessing.canvasSize(width: 1500, height: 80) == (1280, 68))
        XCTAssertTrue(StaffPreprocessing.canvasSize(width: 1000, height: 300) == (853, 256))
        XCTAssertTrue(StaffPreprocessing.canvasSize(width: 1000, height: 200) == (1280, 256))
    }

    // MARK: OpenCV primitives vs cv2 5.0.0 references

    func testResizeLinearMatchesCV2() throws {
        let cases: [(String, Int, Int)] = [
            ("src_37x131", 300, 90), ("src_37x131", 61, 17), ("src_37x131", 131, 80),
            ("src_37x131", 213, 64), ("src_40x130", 65, 20),
        ]
        for (name, w, h) in cases {
            let src = try PNGDecoder.decode(contentsOf: Self.cv2Refs.appendingPathComponent("\(name).png"))
            let want = [UInt8](try Data(contentsOf: Self.cv2Refs.appendingPathComponent("resize_\(name)_to_\(w)x\(h).bin")))
            let got = try StaffPreprocessing.resizeLinear(
                grayscale: src.grayscale(), width: src.width, height: src.height, toWidth: w, toHeight: h
            )
            let diffs = zip(got, want).filter { $0 != $1 }.count
            XCTAssertEqual(diffs, 0, "\(name) → \(w)x\(h): \(diffs) pixels differ from cv2.resize")
        }
    }

    func testCanvasFromRealCropMatchesHomr() throws {
        let crop = try PNGDecoder.decode(contentsOf: Self.cv2Refs.appendingPathComponent("crop_real.png"))
        let want = try PNGDecoder.decode(contentsOf: Self.cv2Refs.appendingPathComponent("canvas_crop_real.png"))
        XCTAssertEqual([crop.width, crop.height], [509, 181])
        let got = try StaffPreprocessing.canvas(grayscale: crop.grayscale(), width: crop.width, height: crop.height)
        XCTAssertEqual(got, want.grayscale())
        let tensor = try StaffTensor.fromStaffImage(grayscale: crop.grayscale(), width: crop.width, height: crop.height)
        XCTAssertEqual(StaffTensorDiff(tensor, try StaffTensor.fromCanvas(want.grayscale())).maxAbs, 0)
    }

    func testGrayscaleMatchesCV2() throws {
        let rgb = try PNGDecoder.decode(contentsOf: Self.cv2Refs.appendingPathComponent("rgb_24x40.png"))
        XCTAssertEqual([rgb.width, rgb.height, rgb.channels], [40, 24, 3])
        let want = [UInt8](try Data(contentsOf: Self.cv2Refs.appendingPathComponent("rgb_24x40.gray.bin")))
        XCTAssertEqual(rgb.grayscale(), want)
        XCTAssertEqual(
            try StaffPreprocessing.grayscale(interleaved: rgb.pixels, width: 40, height: 24, channels: 3), want
        )
    }

    func testRejectsBadInput() {
        XCTAssertThrowsError(try StaffTensor.fromStaffImage(grayscale: [0, 1, 2], width: 2, height: 2))
        XCTAssertThrowsError(try PNGDecoder.decode([1, 2, 3]))
    }
}
