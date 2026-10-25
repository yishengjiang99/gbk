// SPDX-License-Identifier: AGPL-3.0-or-later
// Port of liebharc/homr @ 7d97c3cee4ad772b50266fdf9dc78bbf9064701e (AGPL-3.0): tests for the page
// preprocessing port (autocrop -> PIL resize -> CLAHE) against fixtures/oracle.pages (homr + cv2 5.0.0 +
// Pillow 12.3.0, tools/oracle/export_page_pipeline.py).
import XCTest
@testable import OMRHomrIOS

final class PagePreprocessTests: XCTestCase {
    static func pagesDir() throws -> URL {
        try WriterOnlyFixtureTests.fixturesRoot().appendingPathComponent("oracle.pages")
    }

    static func stages(_ fid: String) throws -> [String: Any] {
        let url = try pagesDir().appendingPathComponent(fid).appendingPathComponent("stages.json")
        return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    }

    static func inputURL(_ fid: String) throws -> URL {
        let st = try stages(fid)
        let rel = st["input_image"] as! String
        return try WriterOnlyFixtureTests.fixturesRoot().deletingLastPathComponent().appendingPathComponent(rel)
    }

    static func gray(_ url: URL) throws -> (pixels: [UInt8], width: Int, height: Int) {
        try StaffTensor.decodeGrayPNG(Data(contentsOf: url))
    }

    static let fixtures = ["mono.c_major_scale", "piano.grand", "mono.rhythms", "poly.chord", "clefs.bass",
                           "mono.sharps_flats", "mono.rests", "camera.deskew", "synthetic.page_on_table"]

    func checkFixture(_ fid: String) throws {
        let dir = try Self.pagesDir().appendingPathComponent(fid)
        let st = try Self.stages(fid)
        let input = try PagePreprocessTests.gray(PagePreprocessTests.inputURL(fid))
        let out = input.pixels.withUnsafeBufferPointer { p in
            PagePreprocess.run(GrayPlane(base: p.baseAddress!, width: input.width, height: input.height, stride: input.width))
        }
        let ac = st["autocrop"] as! [String: Any]
        XCTAssertEqual(out.cropped, ac["cropped"] as? Bool, fid)
        let size = ac["size"] as! [Int]
        XCTAssertEqual([out.crop.width, out.crop.height], size, fid)
        if let origin = ac["origin"] as? [Int] { XCTAssertEqual([out.crop.x, out.crop.y], origin, fid) }
        let resized = try Self.gray(dir.appendingPathComponent("resized.png"))
        XCTAssertEqual([out.width, out.height], [resized.width, resized.height], fid)
        let rDiff = zip(out.resized, resized.pixels).filter { $0 != $1 }.count
        XCTAssertEqual(rDiff, 0, "\(fid) resize mismatches")
        let pre = try Self.gray(dir.appendingPathComponent("preprocessed.png"))
        let pDiff = zip(out.preprocessed, pre.pixels).filter { $0 != $1 }.count
        XCTAssertEqual(pDiff, 0, "\(fid) CLAHE mismatches")
    }

    func testCScalePageExact() throws { try checkFixture("mono.c_major_scale") }
    func testCameraDeskewUpscaleExact() throws { try checkFixture("camera.deskew") }
    func testSyntheticPageOnTableAutocropExact() throws { try checkFixture("synthetic.page_on_table") }
    /// ~60 s in a debug build; `omr-test segnet-page --compare` covers these in release (see TODO.md).
    func testOtherFixturesExact() throws {
        guard ProcessInfo.processInfo.environment["OMR_SLOW_TESTS"] == "1" else {
            throw XCTSkip("set OMR_SLOW_TESTS=1 (or run omr-test segnet-page --compare per fixture)")
        }
        for f in ["piano.grand", "mono.rhythms", "poly.chord", "clefs.bass", "mono.sharps_flats", "mono.rests"] {
            try checkFixture(f)
        }
    }
}

/// Raw gray8 entry validation (`PagePipeline.validate` / `preprocess(gray8:width:height:)`).
final class PagePipelineInputTests: XCTestCase {
    // MARK: - Color path (homr reads BGR)

    /// Fixture gray as interleaved R, G, B, X; `tint` makes warm "paper" (R = v, G = v*243/255, B = v*217/255).
    static func rgbx(_ g: (pixels: [UInt8], width: Int, height: Int), tint: Bool) -> [UInt8] {
        var out = [UInt8](repeating: 255, count: g.width * g.height * 4)
        for (i, v) in g.pixels.enumerated() {
            let x = Int(v)
            out[i * 4] = v
            out[i * 4 + 1] = tint ? UInt8(x * 243 / 255) : v
            out[i * 4 + 2] = tint ? UInt8(x * 217 / 255) : v
        }
        return out
    }

    static func runColor(_ px: [UInt8], _ w: Int, _ h: Int) -> PagePreprocess.Output {
        px.withUnsafeBufferPointer { p in
            PagePreprocess.run(color: ColorPlane(base: p.baseAddress!, width: w, height: h, stride: w * 4, bytesPerPixel: 4,
                                                 offsets: (0, 1, 2)))
        }
    }

    /// Gray content through the color path is byte-identical to the gray path (all fixtures are gray).
    func testColorPathEqualsGrayPathForGrayPages() throws {
        for fid in ["mono.c_major_scale", "camera.deskew", "synthetic.page_on_table"] {
            let g = try PagePreprocessTests.gray(PagePreprocessTests.inputURL(fid))
            let gray = g.pixels.withUnsafeBufferPointer { p in
                PagePreprocess.run(GrayPlane(base: p.baseAddress!, width: g.width, height: g.height, stride: g.width))
            }
            let color = Self.runColor(Self.rgbx(g, tint: false), g.width, g.height)
            XCTAssertEqual(color.crop, gray.crop, fid)
            XCTAssertEqual(color.resized, gray.resized, fid)
            XCTAssertEqual(color.preprocessed, gray.preprocessed, fid)
        }
    }

    /// Tinted pages vs homr's own color path (autocrop on BGR -> resize_image in color -> apply_clahe),
    /// sha256 of `preprocessed` from homr 7d97c3c + cv2 + Pillow on the same tint.
    func testTintedPagesMatchHomrColorPath() throws {
        let expected = [
            "mono.c_major_scale": "7fa79784fa49727243695c05c5c4d08052de1e1ed3b1063438c3c89366a3ea9b",
            "camera.deskew": "7a7c0ef040e4cada31cd73dfd1d6b1afd0a3aa4dca5835fb869afd5c3e9d0e6a",
            "piano.grand": "8af3e273690ed626a9afea8e46831bd263dc61dac068d0db8f5d0fd21ef44bec",
        ]
        // Gray-first (the old app path) differs from homr on these pages.
        let grayFirst = ["mono.c_major_scale": "3bd8332a9bc3d2ad47571aaf59e4cbf59829a2b0a39a520565000383bd173901"]
        for (fid, sha) in expected.sorted(by: { $0.key < $1.key }) {
            let g = try PagePreprocessTests.gray(PagePreprocessTests.inputURL(fid))
            let px = Self.rgbx(g, tint: true)
            let out = Self.runColor(px, g.width, g.height)
            XCTAssertEqual(CoreMLModelCache.sha256Hex(of: Data(out.preprocessed)), sha, fid)
            if let old = grayFirst[fid] {
                var luma = [UInt8](repeating: 0, count: g.width * g.height)
                for i in 0..<luma.count { luma[i] = PagePreprocess.bgr2gray(r: px[i * 4], g: px[i * 4 + 1], b: px[i * 4 + 2]) }
                let o = luma.withUnsafeBufferPointer { p in
                    PagePreprocess.run(GrayPlane(base: p.baseAddress!, width: g.width, height: g.height, stride: g.width))
                }
                XCTAssertEqual(CoreMLModelCache.sha256Hex(of: Data(o.preprocessed)), old, "\(fid) gray-first reference")
            }
        }
    }

    func testRejectsSizeMismatch() {
        XCTAssertThrowsError(try PagePipeline.preprocess(gray8: Data(count: 99), width: 10, height: 10)) { e in
            guard case OMRError.invalidPixelBuffer(let m) = e else { return XCTFail("\(e)") }
            XCTAssertTrue(m.contains("99") && m.contains("100"), m)
        }
    }

    func testRejectsBadDimensions() {
        for (w, h) in [(0, 10), (10, -1), (PagePipeline.maxSide + 1, 1), (1 << 14, 1 << 14)] {
            XCTAssertThrowsError(try PagePipeline.validate(byteCount: 0, width: w, height: h)) { e in
                guard case OMRError.invalidPixelBuffer = e else { return XCTFail("\(e)") }
            }
        }
        XCTAssertNoThrow(try PagePipeline.validate(byteCount: 12, width: 4, height: 3))
    }

    func testSmallPageRuns() throws {
        // 40x30 white page with a dark bar: exercises resize (upscale to 1920) + CLAHE on a tiny input.
        var px = [UInt8](repeating: 250, count: 40 * 30)
        for x in 5..<35 { px[15 * 40 + x] = 10 }
        let p = try PagePipeline.preprocess(gray8: Data(px), width: 40, height: 30)
        XCTAssertEqual(p.width, 1920)
        XCTAssertEqual(p.height, 1440)
        XCTAssertFalse(p.cropped)
        XCTAssertEqual(p.preprocessed.count, 1920 * 1440)
    }
}
