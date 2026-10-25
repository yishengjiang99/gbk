import XCTest
@testable import OMRHomrIOS

/// Provider policy for the ORT C-API backend on every platform: `.coreML` only for encoder /
/// SegNet sessions (Apple), decoder always `.cpu`, and `.coreML` rejected on Linux.
final class ORTProviderPolicyTests: XCTestCase {
    /// A decoder-shaped backend that reports the provider its session was created with.
    final class ReportingDecoderBackend: ORTSessionBackend, ORTProviderReporting {
        let provider: ORTProvider
        let inputNames = DecoderSession.inputNames + (0..<32).map { "cache_in\($0)" }
        let outputNames = DecoderSession.outputNames + (0..<32).map { "cache_out\($0)" }
        init(modelURL: URL, provider: ORTProvider) throws { self.provider = provider }
        func run(inputs: [String: ORTTensor], outputNames: [String]) throws -> [String: ORTTensor] { [:] }
    }

    func testDecoderRejectsBackendCreatedWithCoreML() throws {
        let vocab = try TokenizerLoader.loadVocabulary()
        let url = URL(fileURLWithPath: "/m/decoder.onnx")
        // Even when the caller claims `.cpu`, a backend that reports `.coreML` is refused.
        XCTAssertThrowsError(
            try DecoderSession(vocabulary: vocab, backend: ReportingDecoderBackend(modelURL: url, provider: .coreML), provider: .cpu)
        )
        XCTAssertNoThrow(
            try DecoderSession(vocabulary: vocab, backend: ReportingDecoderBackend(modelURL: url, provider: .cpu), provider: .cpu)
        )
    }

    func testORTCSessionCoreMLThrowsOnLinux() throws {
        #if canImport(CONNXRuntime) && os(Linux)
        // Rejected before any model is opened.
        XCTAssertThrowsError(try ORTCSession(modelURL: URL(fileURLWithPath: "/nonexistent.onnx"), provider: .coreML)) { error in
            guard case ORTCError.unsupportedProvider = error else {
                return XCTFail("expected unsupportedProvider, got \(error)")
            }
        }
        #else
        throw XCTSkip("Linux CONNXRuntime not linked")
        #endif
    }

    func testORTCSessionReportsCPUProvider() throws {
        #if canImport(CONNXRuntime)
        let models = try WriterOnlyFixtureTests.fixturesRoot().deletingLastPathComponent().appendingPathComponent("models")
        let dec = models.appendingPathComponent("decoder_pytorch_model_465-597144cab54c8f6d0f6c9619df5c5312694eadd6.onnx")
        guard FileManager.default.fileExists(atPath: dec.path) else { throw XCTSkip("run scripts/fetch-models") }
        let s = try ORTCSession(modelURL: dec, provider: .cpu)
        XCTAssertEqual(s.provider, .cpu)
        XCTAssertEqual((s as any ORTProviderReporting).provider, .cpu)
        #else
        throw XCTSkip("CONNXRuntime not linked")
        #endif
    }
}
