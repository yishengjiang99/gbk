import XCTest
@testable import OMRHomrIOS

final class DecoderLoopTests: XCTestCase {
    func testUnconfiguredRunnerRefusesFakeLogits() throws {
        let vocab = try TokenizerLoader.loadVocabulary()
        let loop = DecoderLoop(vocabulary: vocab)
        let ctx = EncoderContext(bytes: Data(), dtype: .float32, shape: [])
        XCTAssertThrowsError(
            try loop.generate(context: ctx, stepRunner: UnconfiguredDecoderStepRunner())
        ) { error in
            guard case OMRError.sessionNotConfigured = error else {
                return XCTFail("expected sessionNotConfigured, got \(error)")
            }
        }
    }

    func testGenerateRejectsFP16ContextAtSeam() throws {
        let vocab = try TokenizerLoader.loadVocabulary()
        let loop = DecoderLoop(vocabulary: vocab)
        let ctx = EncoderContext(bytes: Data(), dtype: .float16, shape: [])
        XCTAssertThrowsError(
            try loop.generate(context: ctx, stepRunner: UnconfiguredDecoderStepRunner())
        ) { error in
            guard case OMRError.sessionNotConfigured(let msg) = error else {
                return XCTFail("expected sessionNotConfigured, got \(error)")
            }
            XCTAssertTrue(msg.contains("fp32"), msg)
        }
    }

    func testLoopStopsOnEOSWithoutEmittingControl() throws {
        let vocab = try TokenizerLoader.loadVocabulary()
        let loop = DecoderLoop(vocabulary: vocab)
        let ctx = EncoderContext(bytes: Data(), dtype: .float32, shape: [])
        let runner = ImmediateEOSRunner(eos: vocab.eosToken, nonote: vocab.nonoteToken)
        let symbols = try loop.generate(context: ctx, stepRunner: runner)
        XCTAssertTrue(symbols.isEmpty)
        XCTAssertEqual(runner.steps, 1)
        XCTAssertEqual(runner.lastCacheLen, 0)
        XCTAssertEqual(runner.lastUseFullContext, true)
    }

    func testLoopEmitsOneSymbolThenEOS_MatchesUpstreamOrder() throws {
        let vocab = try TokenizerLoader.loadVocabulary()
        let loop = DecoderLoop(vocabulary: vocab)
        let ctx = EncoderContext(bytes: Data(), dtype: .float32, shape: [1, 10, 512])
        let bar = try XCTUnwrap(vocab.rhythm["barline"])
        let runner = ScriptedRunner(outputs: [
            DecoderStepOutput(
                rhythmArgmax: bar,
                pitchArgmax: vocab.nonoteToken,
                liftArgmax: vocab.nonoteToken,
                positionArgmax: vocab.nonoteToken,
                articulationArgmax: vocab.nonoteToken,
                slurArgmax: vocab.nonoteToken
            ),
            DecoderStepOutput(
                rhythmArgmax: vocab.eosToken,
                pitchArgmax: vocab.nonoteToken,
                liftArgmax: vocab.nonoteToken,
                positionArgmax: vocab.nonoteToken,
                articulationArgmax: vocab.nonoteToken,
                slurArgmax: vocab.nonoteToken
            ),
        ])
        let symbols = try loop.generate(context: ctx, stepRunner: runner)
        XCTAssertEqual(symbols.count, 1)
        XCTAssertEqual(symbols[0].rhythm, "barline")
        XCTAssertEqual(symbols[0].pitch, EncodedSymbol.nonote)
        XCTAssertEqual(runner.inputs.count, 2)
        XCTAssertEqual(runner.inputs[0].useFullContext, true)
        XCTAssertEqual(runner.inputs[0].cacheLen, 0)
        XCTAssertEqual(runner.inputs[1].useFullContext, false)
        XCTAssertEqual(runner.inputs[1].cacheLen, 1)
        XCTAssertEqual(runner.inputs[1].rhythm, bar) // last rhythm fed back
    }

    func testPublicParseStillFailsGate1Clearly() throws {
        XCTAssertThrowsError(
            try OMRHomrIOS.parseSheetMusicWithLayout(
                input: ParseSheetMusicInput(imageData: Data([0x89, 0x50]), staffOnly: true)
            )
        ) { error in
            guard case OMRError.staffOnlyGate1NotReady = error else {
                return XCTFail("expected staffOnlyGate1NotReady, got \(error)")
            }
        }
    }

    func testOracleFixtureDirectoryHookShips() {
        let keep = Bundle.module.url(
            forResource: ".gitkeep",
            withExtension: nil,
            subdirectory: "Fixtures/c_scale_staff_oracle"
        )
        let readme = Bundle.module.url(
            forResource: "README",
            withExtension: "md",
            subdirectory: "Fixtures"
        )
        XCTAssertTrue(
            keep != nil || readme != nil,
            "oracle fixture hook path missing from test bundle"
        )
    }

    func testStaffInputSpecMatchesUpstreamConfig() {
        XCTAssertEqual(StaffInputSpec.nchwShape, [1, 1, 256, 1280])
        XCTAssertEqual(StaffInputSpec.maxHeight, 256)
        XCTAssertEqual(StaffInputSpec.maxWidth, 1280)
        XCTAssertEqual(StaffInputSpec.normalizeMean, 0.7931, accuracy: 0.0001)
        XCTAssertEqual(StaffInputSpec.normalizeStd, 0.1738, accuracy: 0.0001)
        XCTAssertTrue(StaffInputSpec.isValidStaffNCHW([1, 1, 256, 1280]))
        XCTAssertFalse(StaffInputSpec.isValidStaffNCHW([1, 3, 256, 1280]))
    }

    func testFP16ContextCastWidensBytes() {
        // 1.0 in float16 is 0x3C00; -2.0 is 0xC000
        var bytes = Data()
        func appendU16(_ v: UInt16) {
            var le = v.littleEndian
            withUnsafeBytes(of: &le) { bytes.append(contentsOf: $0) }
        }
        appendU16(0x3C00)
        appendU16(0xC000)
        let fp16 = EncoderContext(bytes: bytes, dtype: .float16, shape: [1, 2])
        let fp32 = fp16.castToFP32ForDecoder()
        XCTAssertEqual(fp32.dtype, .float32)
        XCTAssertEqual(fp32.bytes.count, 8)
        let floats: [Float] = fp32.bytes.withUnsafeBytes { raw in
            Array(raw.bindMemory(to: Float.self))
        }
        XCTAssertEqual(floats.count, 2)
        XCTAssertEqual(floats[0], 1.0, accuracy: 1e-6)
        XCTAssertEqual(floats[1], -2.0, accuracy: 1e-6)
    }

    func testOracleSequenceCompare() {
        let a = [
            EncodedSymbol(rhythm: "note_4", pitch: "C4", lift: "_", articulation: "_", slur: "_", position: "upper"),
            EncodedSymbol(rhythm: "note_4", pitch: "D4", lift: "_", articulation: "_", slur: "_", position: "upper"),
        ]
        let seq = OracleSymbolSequence(encoded: a)
        XCTAssertTrue(seq.mismatches(vs: OracleSymbolSequence(encoded: a)).isEmpty)
        var b = a
        b[1] = EncodedSymbol(rhythm: "note_4", pitch: "E4", lift: "_", articulation: "_", slur: "_", position: "upper")
        let mism = seq.mismatches(vs: OracleSymbolSequence(encoded: b))
        XCTAssertFalse(mism.isEmpty)
        XCTAssertTrue(mism.contains { $0.contains("pitch @1") })
    }
}

private final class ImmediateEOSRunner: DecoderStepRunning, @unchecked Sendable {
    let eos: Int
    let nonote: Int
    private(set) var steps: Int = 0
    private(set) var lastCacheLen: Int?
    private(set) var lastUseFullContext: Bool?

    init(eos: Int, nonote: Int) {
        self.eos = eos
        self.nonote = nonote
    }

    func runStep(_ input: DecoderStepInput) throws -> DecoderStepOutput {
        steps += 1
        lastCacheLen = input.cacheLen
        lastUseFullContext = input.useFullContext
        return DecoderStepOutput(
            rhythmArgmax: eos,
            pitchArgmax: nonote,
            liftArgmax: nonote,
            positionArgmax: nonote,
            articulationArgmax: nonote,
            slurArgmax: nonote
        )
    }
}

private final class ScriptedRunner: DecoderStepRunning, @unchecked Sendable {
    private var outputs: [DecoderStepOutput]
    private(set) var inputs: [DecoderStepInput] = []

    init(outputs: [DecoderStepOutput]) {
        self.outputs = outputs
    }

    func runStep(_ input: DecoderStepInput) throws -> DecoderStepOutput {
        inputs.append(input)
        guard !outputs.isEmpty else {
            throw OMRError.sessionNotConfigured("scripted runner exhausted")
        }
        return outputs.removeFirst()
    }
}
