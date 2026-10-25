// SPDX-License-Identifier: AGPL-3.0-or-later
import XCTest
@testable import OMRHomrIOS

/// Public PNG entry points (`StaffTensor.fromStaffImage(pngURL:)`, `(pngData:)`, `fromPage(pngURL:geometry:)`):
/// same bytes as the Gate-1 oracle tensor, cv2 imread/BGR2GRAY semantics, and every unsupported or
/// malformed PNG throws `StaffTensor.PNGLoadError` instead of trapping.
final class StaffTensorPNGTests: XCTestCase {
    static func gateDir() throws -> URL {
        try WriterOnlyFixtureTests.fixturesRoot().appendingPathComponent("oracle.c_scale_staff")
    }

    // MARK: oracle

    func testFromStaffImagePNGURLMatchesOracleExactly() throws {
        let dir = try Self.gateDir()
        let want = try StaffTensor.loadNPY(dir.appendingPathComponent("staff.npy"))
        let got = try StaffTensor.fromStaffImage(pngURL: dir.appendingPathComponent("staff.png"))
        XCTAssertEqual(got.shape, [1, 1, 256, 1280])
        XCTAssertEqual(StaffTensorDiff(got, want).maxAbs, 0)
        XCTAssertEqual(got.values, want.values)
    }

    func testFromStaffImagePNGDataMatchesOracleExactly() throws {
        let dir = try Self.gateDir()
        let want = try StaffTensor.loadNPY(dir.appendingPathComponent("staff.npy"))
        let got = try StaffTensor.fromStaffImage(pngData: Data(contentsOf: dir.appendingPathComponent("staff.png")))
        XCTAssertEqual(StaffTensorDiff(got, want).maxAbs, 0)
    }

    func testFromPagePNGURLMatchesOracleExactly() throws {
        let page = try WriterOnlyFixtureTests.fixturesRoot().appendingPathComponent("oracle.c_scale_prepare")
        let geo = try StaffPrepare.loadGeometry(page.appendingPathComponent("geometry.json"))
        let got = try StaffTensor.fromPage(pngURL: page.appendingPathComponent("page.png"), geometry: geo)
        let want = try StaffTensor.loadNPY(Self.gateDir().appendingPathComponent("staff.npy"))
        XCTAssertEqual(StaffTensorDiff(got, want).maxAbs, 0)
        let r = try StaffPrepare.prepareStaffImage(pngURL: page.appendingPathComponent("page.png"), geometry: geo)
        XCTAssertEqual(r.pixels, try StaffPrepare.loadGrayNPY(page.appendingPathComponent("prepared.npy")).pixels)
    }

    // MARK: color handling (cv2.imread IMREAD_COLOR + COLOR_BGR2GRAY)

    func testColorTypesDecodeToCV2Gray() throws {
        let rgb: [UInt8] = [255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 200, 90]
        var want: [UInt8] = []
        for i in 0..<4 {
            let r = Int(rgb[i * 3]) * 9798, g = Int(rgb[i * 3 + 1]) * 19235, b = Int(rgb[i * 3 + 2]) * 3735
            want.append(UInt8((r + g + b + 16384) >> 15))
        }
        XCTAssertEqual(want, [76, 150, 29, 131]) // cv2 5.0.0 COLOR_BGR2GRAY on the same pixels
        XCTAssertEqual(try StaffTensor.decodeGrayPNG(PNGFixture.make(4, 1, colorType: 2, samples: rgb)).pixels, want)
        // RGBA: alpha ignored (no premultiply / compositing)
        var rgba: [UInt8] = []
        for i in 0..<4 { rgba += Array(rgb[(i * 3)..<(i * 3 + 3)]); rgba.append(UInt8(i * 60)) }
        XCTAssertEqual(try StaffTensor.decodeGrayPNG(PNGFixture.make(4, 1, colorType: 6, samples: rgba)).pixels, want)
        // palette
        let plte = PNGFixture.chunk("PLTE", rgb)
        XCTAssertEqual(try StaffTensor.decodeGrayPNG(PNGFixture.make(4, 1, colorType: 3, samples: [0, 1, 2, 3], extra: plte)).pixels, want)
        // gray and gray+alpha pass through
        XCTAssertEqual(try StaffTensor.decodeGrayPNG(PNGFixture.make(3, 1, colorType: 0, samples: [0, 128, 255])).pixels, [0, 128, 255])
        XCTAssertEqual(try StaffTensor.decodeGrayPNG(PNGFixture.make(2, 1, colorType: 4, samples: [7, 0, 9, 255])).pixels, [7, 9])
        // gAMA / iCCP / sRGB chunks are ignored: no color management
        let gama = PNGFixture.chunk("gAMA", [0, 0, 0x5B, 0x8E]) + PNGFixture.chunk("sRGB", [0])
        XCTAssertEqual(try StaffTensor.decodeGrayPNG(PNGFixture.make(4, 1, colorType: 2, samples: rgb, extra: gama)).pixels, want)
    }

    // MARK: unsupported / malformed input throws

    func testUnsupportedVariantsThrowDescriptiveErrors() {
        func expect(_ d: Data, _ check: (StaffTensor.PNGLoadError) -> Bool, line: UInt = #line) {
            XCTAssertThrowsError(try StaffTensor.fromStaffImage(pngData: d), line: line) { e in
                guard let pe = e as? StaffTensor.PNGLoadError else { return XCTFail("\(e)", line: line) }
                XCTAssertTrue(check(pe), "\(pe)", line: line)
                XCTAssertTrue(pe.description.hasPrefix("StaffTensor:"), line: line)
            }
        }
        func unsupported(_ needle: String) -> (StaffTensor.PNGLoadError) -> Bool {
            { if case .unsupported(let m) = $0 { return m.contains(needle) }; return false }
        }
        expect(Data("GIF89a not a png".utf8)) { $0 == .notPNG }
        expect(Data()) { $0 == .notPNG }
        expect(PNGFixture.make(2, 1, colorType: 0, depth: 16, samples: [0, 0, 0, 0]), unsupported("bit depth 16"))
        expect(PNGFixture.make(8, 1, colorType: 0, depth: 1, samples: [0xAA]), unsupported("bit depth 1"))
        expect(PNGFixture.make(1, 1, colorType: 0, interlace: 1, samples: [0]), unsupported("interlaced"))
        expect(PNGFixture.make(1, 1, colorType: 5, samples: [0]), unsupported("color type 5"))
        expect(PNGFixture.header(width: 70_000, height: 1, colorType: 0), unsupported("size 70000x1"))
        expect(PNGFixture.header(width: 20_000, height: 20_000, colorType: 0), unsupported("size"))
        expect(PNGFixture.make(1, 1, colorType: 3, samples: [0])) { if case .corrupt = $0 { return true }; return false }
        XCTAssertThrowsError(try StaffTensor.fromStaffImage(pngURL: URL(fileURLWithPath: "/nonexistent/staff.png"))) {
            guard case .unreadable? = $0 as? StaffTensor.PNGLoadError else { return XCTFail("\($0)") }
        }
    }

    func testDecompressionBombThrows() {
        // 1x1 gray image whose IDAT inflates to 1 MB (stored blocks): rejected, not allocated.
        let d = PNGFixture.make(1, 1, colorType: 0, samples: [0], rawOverride: [UInt8](repeating: 0, count: 1 << 20))
        XCTAssertThrowsError(try StaffTensor.fromStaffImage(pngData: d)) {
            guard case .corrupt? = $0 as? StaffTensor.PNGLoadError else { return XCTFail("\($0)") }
        }
    }

    func testTruncatedAndMutatedPNGsNeverTrap() throws {
        // Real compressed data (dynamic Huffman) from the fixture: every truncation throws.
        let full = try Data(contentsOf: Self.gateDir().appendingPathComponent("staff.png"))
        for n in stride(from: 0, to: full.count, by: max(1, full.count / 300)) {
            XCTAssertThrowsError(try StaffTensor.decodeGrayPNG(full.prefix(n)), "prefix \(n)")
        }
        // Random byte flips on a small image: either decode (right size) or throw PNGLoadError.
        var rng = SplitMix(seed: 7)
        var samples = [UInt8](repeating: 0, count: 12 * 9 * 3)
        for i in samples.indices { samples[i] = UInt8(truncatingIfNeeded: rng.next()) }
        let base = [UInt8](PNGFixture.make(12, 9, colorType: 2, samples: samples, fixedHuffman: true))
        for _ in 0..<3000 {
            var b = base
            for _ in 0..<(1 + Int(rng.next() % 4)) {
                let i = 8 + Int(rng.next() % UInt64(b.count - 8))
                b[i] = UInt8(truncatingIfNeeded: rng.next())
            }
            do {
                let g = try StaffTensor.decodeGrayPNG(Data(b))
                XCTAssertEqual(g.pixels.count, g.width * g.height)
            } catch {
                XCTAssertTrue(error is StaffTensor.PNGLoadError, "\(error)")
            }
        }
    }
}

struct SplitMix {
    var s: UInt64
    init(seed: UInt64) { s = seed }
    mutating func next() -> UInt64 {
        s &+= 0x9E37_79B9_7F4A_7C15
        var z = s
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

/// Tiny PNG writer for tests: filter 0 rows, zlib stored blocks (or one fixed-Huffman block of literals).
enum PNGFixture {
    static func crc32(_ d: [UInt8]) -> UInt32 {
        var c: UInt32 = 0xFFFF_FFFF
        for b in d {
            c ^= UInt32(b)
            for _ in 0..<8 { c = (c >> 1) ^ (c & 1 == 1 ? 0xEDB8_8320 : 0) }
        }
        return ~c
    }
    static func be32(_ v: Int) -> [UInt8] {
        let a = UInt8((v >> 24) & 0xFF), b = UInt8((v >> 16) & 0xFF), c = UInt8((v >> 8) & 0xFF), d = UInt8(v & 0xFF)
        return [a, b, c, d]
    }
    static func chunk(_ type: String, _ body: [UInt8]) -> [UInt8] {
        let tb = [UInt8](type.utf8) + body
        return be32(body.count) + tb + be32(Int(crc32(tb)))
    }
    static func ihdr(_ w: Int, _ h: Int, _ colorType: Int, _ depth: Int, _ interlace: Int) -> [UInt8] {
        chunk("IHDR", be32(w) + be32(h) + [UInt8(depth), UInt8(colorType), 0, 0, UInt8(interlace)])
    }
    static let signature: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]

    static func header(width: Int, height: Int, colorType: Int) -> Data {
        Data(signature + ihdr(width, height, colorType, 8, 0) + chunk("IDAT", zlib([0])) + chunk("IEND", []))
    }

    static func zlib(_ raw: [UInt8], fixedHuffman: Bool = false) -> [UInt8] {
        var out: [UInt8] = [0x78, 0x01]
        if fixedHuffman {
            // BFINAL=1, BTYPE=01, literals only, then end-of-block (256).
            var bits: [Int] = [1, 1, 0]
            func code(_ v: Int, _ n: Int) { for i in stride(from: n - 1, through: 0, by: -1) { bits.append(v >> i & 1) } }
            for b in raw { if b < 144 { code(0x30 + Int(b), 8) } else { code(0x190 + Int(b) - 144, 9) } }
            code(0, 7)
            var byte = 0, n = 0
            for bit in bits { byte |= bit << n; n += 1; if n == 8 { out.append(UInt8(byte)); byte = 0; n = 0 } }
            if n > 0 { out.append(UInt8(byte)) }
        } else {
            var i = 0
            repeat {
                let len = min(65535, raw.count - i)
                out.append(i + len == raw.count ? 1 : 0)
                out += [UInt8(len & 0xFF), UInt8(len >> 8), UInt8(~len & 0xFF), UInt8((~len >> 8) & 0xFF)]
                out += raw[i..<(i + len)]
                i += len
            } while i < raw.count
        }
        var a: UInt32 = 1, b: UInt32 = 0
        for x in raw { a = (a + UInt32(x)) % 65521; b = (b + a) % 65521 }
        return out + be32(Int(b << 16 | a))
    }

    static func make(_ w: Int, _ h: Int, colorType: Int, depth: Int = 8, interlace: Int = 0, samples: [UInt8],
                     extra: [UInt8] = [], rawOverride: [UInt8]? = nil, fixedHuffman: Bool = false) -> Data {
        let rowBytes = samples.count / h
        var raw: [UInt8] = []
        for y in 0..<h { raw.append(0); raw += samples[(y * rowBytes)..<((y + 1) * rowBytes)] }
        return Data(signature + ihdr(w, h, colorType, depth, interlace) + extra
            + chunk("IDAT", zlib(rawOverride ?? raw, fixedHuffman: fixedHuffman)) + chunk("IEND", []))
    }
}
