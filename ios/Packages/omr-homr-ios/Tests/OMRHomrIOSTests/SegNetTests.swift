// SPDX-License-Identifier: AGPL-3.0-or-later
// Port of liebharc/homr @ 7d97c3cee4ad772b50266fdf9dc78bbf9064701e (AGPL-3.0): tests for the SegNet
// tiling / merge port (homr/segmentation/inference_segnet.py) against fixtures/oracle.pages.
import XCTest
@testable import OMRHomrIOS

/// Stand-in model: class = min(pixel / 43, 5) per pixel (logit 1.0 for it, 0 elsewhere), so the tile
/// geometry, padding and merge can be checked without ONNX Runtime.
final class FakeSegNetBackend: ORTSessionBackend {
    var calls: [[Int]] = []
    init() {}
    required init(modelURL: URL, provider: ORTProvider) throws { fatalError("unused") }
    var inputNames: [String] { ["input"] }
    var outputNames: [String] { ["output"] }
    func run(inputs: [String: ORTTensor], outputNames: [String]) throws -> [String: ORTTensor] {
        let t = inputs["input"]!
        calls.append(t.shape)
        let n = t.shape[0], plane = 320 * 320
        var out = Data(count: n * 6 * plane * 2)
        t.data.withUnsafeBytes { raw in
            let src = raw.bindMemory(to: UInt16.self)
            out.withUnsafeMutableBytes { o in
                let dst = o.bindMemory(to: UInt16.self)
                for b in 0..<n {
                    for i in 0..<plane {
                        let v = Int(EncoderContext.float32(fromFloat16Bits: src[b * 3 * plane + i]))
                        let c = min(v / 43, 5)
                        dst[(b * 6 + c) * plane + i] = 0x3C00
                    }
                }
            }
        }
        return ["output": ORTTensor(type: .float16, shape: [n, 6, 320, 320], data: out)]
    }
}

final class SegNetTests: XCTestCase {
    func testTileOriginsMatchHomrLoops() {
        let o = SegNetSession.tileOrigins(width: 1920, height: 2715)
        XCTAssertEqual(o.count, 54)
        XCTAssertEqual(o.first!.y, 0); XCTAssertEqual(o.first!.x, 0)
        XCTAssertEqual(o[5].x, 1600)
        XCTAssertEqual(o.last!.y, 2715 - 320); XCTAssertEqual(o.last!.x, 1600)
        XCTAssertEqual(SegNetSession.tileCount(width: 1920, height: 1366), 30)
        // smaller than a window: one tile at a negative origin (image at the patch's top-left)
        let s = SegNetSession.tileOrigins(width: 100, height: 50)
        XCTAssertEqual(s.count, 1)
        XCTAssertEqual(s[0].y, -270); XCTAssertEqual(s[0].x, -220)
    }

    /// homr merge_patches: float32 mean of overlapping class ids, truncated; batches of 8.
    func testMergeAveragesOverlapsLikeHomr() throws {
        let w = 700, h = 500
        var page = [UInt8](repeating: 0, count: w * h)
        for y in 0..<h { for x in 0..<w { page[y * w + x] = UInt8((x * 7 + y * 3) % 256) } }
        let fake = FakeSegNetBackend()
        let merged = try SegNetSession(backend: fake).segment(preprocessed: page, width: w, height: h)
        // 3 x 2 tiles, one batch padded to the fixed batch size (stable CoreML/ANE input shape)
        XCTAssertEqual(fake.calls.map { $0[0] }, [SegNetSession.batchSize])
        // every tile sees the same pixel values at the same page position, so the mean equals the class
        for i in 0..<(w * h) { XCTAssertEqual(Int(merged[i]), min(Int(page[i]) / 43, 5)) }
        // padding: a page narrower than a window is padded with 255 -> class 5, not merged back
        let small = [UInt8](repeating: 0, count: 50 * 40)
        let m2 = try SegNetSession(backend: FakeSegNetBackend()).segment(preprocessed: small, width: 50, height: 40)
        XCTAssertEqual(Set(m2), [0])
    }

    func testTruncatedMeanOnDisagreeingOverlap() throws {
        // Backend that answers class 1 for the first tile and 4 for the others: overlap mean (1+4)/2 = 2.5 -> 2.
        final class Alternating: ORTSessionBackend {
            var n = 0
            init() {}
            required init(modelURL: URL, provider: ORTProvider) throws { fatalError() }
            var inputNames: [String] { ["input"] }
            var outputNames: [String] { ["output"] }
            func run(inputs: [String: ORTTensor], outputNames: [String]) throws -> [String: ORTTensor] {
                let b = inputs["input"]!.shape[0], plane = 320 * 320
                var out = Data(count: b * 6 * plane * 2)
                out.withUnsafeMutableBytes { o in
                    let d = o.bindMemory(to: UInt16.self)
                    for k in 0..<b {
                        let c = (n + k) == 0 ? 1 : 4
                        for i in 0..<plane { d[(k * 6 + c) * plane + i] = 0x3C00 }
                    }
                }
                n += b
                return ["output": ORTTensor(type: .float16, shape: [b, 6, 320, 320], data: out)]
            }
        }
        let w = 400, h = 320   // tiles at x=0 and x=80: overlap columns 80..<320
        let m = try SegNetSession(backend: Alternating()).segment(preprocessed: [UInt8](repeating: 9, count: w * h), width: w, height: h)
        XCTAssertEqual(m[10], 1)
        XCTAssertEqual(m[100], 2)
        XCTAssertEqual(m[350], 4)
    }

    /// Real SegNet fp16 on ORT CPU: two tiles of the c-scale preprocessed page == homr's argmax exactly.
    func testRealSegNetTilesMatchOracle() throws {
        #if canImport(CONNXRuntime)
        let fixtures = try WriterOnlyFixtureTests.fixturesRoot()
        let model = fixtures.deletingLastPathComponent().appendingPathComponent(
            "models/segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f_fp16.onnx")
        guard FileManager.default.fileExists(atPath: model.path) else {
            throw XCTSkip("pinned models missing; run scripts/fetch-models")
        }
        let dir = fixtures.appendingPathComponent("oracle.pages/mono.c_major_scale")
        let pre = try PagePipeline.decodeGrayPNG(Data(contentsOf: dir.appendingPathComponent("preprocessed.png")))
        struct Tiles: Decodable { struct T: Decodable { var y: Int; var x: Int; var argmax: String }; var tiles: [T] }
        let ref = try JSONDecoder().decode(Tiles.self, from: Data(contentsOf: dir.appendingPathComponent("tiles.json")))
        let seg = SegNetSession(backend: try ORTCSession(modelURL: model, provider: .cpu, intraOpThreads: 0))
        var got: [Int: [UInt8]] = [:]
        try pre.pixels.withUnsafeBufferPointer { p in
            try seg.runTiles(p, width: pre.width, height: pre.height, origins: ref.tiles.map { ($0.y, $0.x) }) { got[$0] = $1 }
        }
        for (i, t) in ref.tiles.enumerated() {
            let want = [UInt8](Data(base64Encoded: t.argmax)!)
            let ne = zip(want, got[i]!).filter { $0 != $1 }.count
            XCTAssertEqual(ne, 0, "tile (\(t.y), \(t.x)) argmax mismatches")
        }
        #else
        throw XCTSkip("CONNXRuntime not linked; run scripts/fetch-ort (docs/ORT-LINUX.md)")
        #endif
    }
}
