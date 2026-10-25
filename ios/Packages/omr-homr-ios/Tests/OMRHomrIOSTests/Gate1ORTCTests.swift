import XCTest
import OMRPNG
@testable import OMRHomrIOS

/// Gate 1 on Linux with real ONNX Runtime (ORTCSession, CPU EP): `staff.npy` →
/// `decodeStaff(tensor:)` (and the same from `staff.png` via `StaffTensor.fromStaffImage`) must equal `fixtures/oracle.c_scale_staff/expected.tokens.json` exactly.
/// Skips when ORT (`scripts/fetch-ort`) or the pinned models (`scripts/fetch-models`) are absent.
final class Gate1ORTCTests: XCTestCase {
    func testCScaleStaffMatchesOracleExactly() throws {
        #if canImport(CONNXRuntime)
        let fixtures = try WriterOnlyFixtureTests.fixturesRoot()
        let models = fixtures.deletingLastPathComponent().appendingPathComponent("models")
        let stem = "pytorch_model_465-597144cab54c8f6d0f6c9619df5c5312694eadd6"
        let enc = models.appendingPathComponent("encoder_\(stem)_fp16.onnx")
        let dec = models.appendingPathComponent("decoder_\(stem).onnx")
        guard FileManager.default.fileExists(atPath: enc.path),
              FileManager.default.fileExists(atPath: dec.path) else {
            throw XCTSkip("pinned models missing; run scripts/fetch-models")
        }
        let dir = fixtures.appendingPathComponent("oracle.c_scale_staff")
        let session = try StaffInferenceSession(
            encoder: ORTCSession(modelURL: enc, provider: .cpu),
            decoder: ORTCSession(modelURL: dec, provider: .cpu),
            vocabulary: TokenizerLoader.loadVocabulary()
        )
        let got = try session.decodeStaff(tensor: StaffTensor.loadNPY(dir.appendingPathComponent("staff.npy")))
        struct File: Decodable { var symbols: [OracleSymbolFields] }
        let want = try JSONDecoder().decode(
            File.self, from: Data(contentsOf: dir.appendingPathComponent("expected.tokens.json"))
        ).symbols
        XCTAssertEqual(got.map(\.oracleFields), want)

        // End to end from the image: staff.png → Swift homr preprocessing → same 12 tokens.
        let png = try PNGDecoder.decode(contentsOf: dir.appendingPathComponent("staff.png"))
        let fromPNG = try session.decodeStaff(
            tensor: StaffTensor.fromStaffImage(grayscale: png.grayscale(), width: png.width, height: png.height)
        )
        XCTAssertEqual(fromPNG.map(\.oracleFields), want)
        #else
        throw XCTSkip("CONNXRuntime not linked; run scripts/fetch-ort (docs/ORT-LINUX.md)")
        #endif
    }
}
