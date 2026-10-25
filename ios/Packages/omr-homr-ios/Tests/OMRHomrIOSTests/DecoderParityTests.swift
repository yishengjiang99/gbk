import XCTest
@testable import OMRHomrIOS

/// Exact old (generic Data-copy) vs zero-copy IoBinding decoder parity + instrumentation sample.
final class DecoderParityTests: XCTestCase {

    func testZeroCopyMatchesGenericEveryField() throws {
        #if canImport(CONNXRuntime)
        let fixtures = try WriterOnlyFixtureTests.fixturesRoot()
        let models = fixtures.deletingLastPathComponent().appendingPathComponent("models")
        let stem = "pytorch_model_465-597144cab54c8f6d0f6c9619df5c5312694eadd6"
        let encURL = models.appendingPathComponent("encoder_\(stem)_fp16.onnx")
        let decURL = models.appendingPathComponent("decoder_\(stem).onnx")
        guard FileManager.default.fileExists(atPath: encURL.path),
              FileManager.default.fileExists(atPath: decURL.path) else {
            throw XCTSkip("pinned models missing; run scripts/fetch-models")
        }
        let vocab = try TokenizerLoader.loadVocabulary()
        let encoder = try ORTCSession(modelURL: encURL, provider: .cpu)
        let decoderBackend = try ORTCSession(modelURL: decURL, provider: .cpu)
        let decoder = try DecoderSession(vocabulary: vocab, backend: decoderBackend, provider: .cpu)
        let tensor = try StaffTensor.loadNPY(
            fixtures.appendingPathComponent("oracle.c_scale_staff/staff.npy")
        )
        let context = try EncoderSession(
            backend: encoder, provider: .cpuFallback, inputElementType: .float16
        ).generateContext(staffImageNormalized: tensor.float32LEData).castToFP32ForDecoder()

        // Generic path
        ORTDecoderStepRunner.forceGenericPath = true
        defer { ORTDecoderStepRunner.forceGenericPath = false }
        let genericRunner = try decoder.makeStepRunner(context: context)
        let generic = try DecoderLoop(vocabulary: vocab).generate(context: context, stepRunner: genericRunner)
        XCTAssertNil(genericRunner.boundMetrics, "generic path must not use IoBinding metrics")

        // Zero-copy path (same encoder context bytes)
        ORTDecoderStepRunner.forceGenericPath = false
        let boundRunner = try decoder.makeStepRunner(context: context)
        let bound = try DecoderLoop(vocabulary: vocab).generate(context: context, stepRunner: boundRunner)
        let metrics = try XCTUnwrap(boundRunner.boundMetrics)
        XCTAssertEqual(metrics.cacheBytesCopiedThroughSwift, 0)
        XCTAssertGreaterThan(metrics.nativeCacheRebinds, 0)
        XCTAssertEqual(metrics.tokenCount, bound.count + 1, "symbols + EOS step")
        XCTAssertGreaterThan(metrics.ortInferenceMs, 0)
        XCTAssertGreaterThan(metrics.totalDecoderMs, 0)

        XCTAssertEqual(bound.count, generic.count)
        for (i, (a, b)) in zip(bound, generic).enumerated() {
            XCTAssertEqual(a.oracleFields, b.oracleFields, "symbol \(i)")
            // Attention centers must match (raw float32 blob).
            XCTAssertEqual(a.attentionPayload, b.attentionPayload, "attention \(i)")
        }

        // Sample instrumentation line for Copy-as-prompt / parent report.
        let sample = String(
            format: "decoder_bound tokens=%d total=%.1fms ort=%.1fms bind=%.1fms argmax=%.1fms rebinds=%d cacheSwiftBytes=%d avg=%.2f p50=%.2f p95=%.2f",
            metrics.tokenCount, metrics.totalDecoderMs, metrics.ortInferenceMs, metrics.bindingSetupMs,
            metrics.argmaxMs, metrics.nativeCacheRebinds, metrics.cacheBytesCopiedThroughSwift,
            metrics.avgTokenMs, metrics.p50TokenMs, metrics.p95TokenMs
        )
        print(sample)
        #else
        throw XCTSkip("CONNXRuntime not linked")
        #endif
    }

    /// Staff-level E2E: raw tokens, position-filtered tokens, MIDI note events, noteLayout entries.
    func testCScaleStaffE2ETokensMIDILayout() throws {
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
        let session = try StaffInferenceSession(
            encoder: ORTCSession(modelURL: enc, provider: .cpu),
            decoder: ORTCSession(modelURL: dec, provider: .cpu),
            vocabulary: TokenizerLoader.loadVocabulary()
        )
        let dir = fixtures.appendingPathComponent("oracle.c_scale_staff")
        let raw = try session.decodeStaff(tensor: StaffTensor.loadNPY(dir.appendingPathComponent("staff.npy")))
        struct File: Decodable { var symbols: [OracleSymbolFields] }
        let want = try JSONDecoder().decode(
            File.self, from: Data(contentsOf: dir.appendingPathComponent("expected.tokens.json"))
        ).symbols
        XCTAssertEqual(raw.map(\.oracleFields), want)

        let filtered = SymbolCleanup.positionFilter(raw, isGrandstaff: false)
        XCTAssertEqual(filtered.map(\.oracleFields), want, "single-staff C-scale: filter is identity")

        let voices = [SymbolCleanup.removeDuplicatedSymbols(filtered + [EncodedSymbol(rhythm: "newline")])]
        let result = PagePipeline.render(voices: voices, grandstaffVoices: [])
        XCTAssertEqual(result.staffCount, 1)
        XCTAssertEqual(result.noteLayout.map(\.midiNote), [60, 62, 64, 65, 67, 69, 71, 72])
        XCTAssertEqual(result.noteLayout.count, 8)
        let smf = try SMFNoteReader.read(from: result.midi)
        XCTAssertEqual(smf.notes.map(\.pitch), [60, 62, 64, 65, 67, 69, 71, 72])

        // Timing struct populated (encoder + decoder > 0).
        XCTAssertGreaterThan(session.lastTiming.encoderMs, 0)
        XCTAssertGreaterThan(session.lastTiming.decoderMs, 0)
        if let m = session.lastTiming.bound {
            XCTAssertEqual(m.cacheBytesCopiedThroughSwift, 0)
            print(String(
                format: "staff_e2e enc=%.1fms dec=%.1fms ort=%.1fms tokens=%d cacheSwiftBytes=%d",
                session.lastTiming.encoderMs, session.lastTiming.decoderMs,
                m.ortInferenceMs, m.tokenCount, m.cacheBytesCopiedThroughSwift
            ))
        }
        #else
        throw XCTSkip("CONNXRuntime not linked")
        #endif
    }

    func testRecommendedConcurrencyAndPoolClamps() {
        let n = PageInferenceSession.recommendedStaffConcurrency
        XCTAssertGreaterThanOrEqual(n, 1)
        XCTAssertLessThanOrEqual(n, 4)
    }
}
