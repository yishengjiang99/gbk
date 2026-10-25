import Foundation

/// Per-staff encode+decode timings for diagnostics / Copy-as-prompt. Thread-safe value.
public struct StaffDecodeTiming: Sendable, Equatable {
    public var encoderMs: Double = 0
    public var decoderMs: Double = 0
    /// Zero-copy IoBinding metrics when the bound decoder path ran; nil on generic path.
    public var bound: DecoderBoundMetrics?

    public init(encoderMs: Double = 0, decoderMs: Double = 0, bound: DecoderBoundMetrics? = nil) {
        self.encoderMs = encoderMs
        self.decoderMs = decoderMs
        self.bound = bound
    }
}


/// Staff-only inference orchestration for gate-1.
///
/// Pipeline (locked): Encoder fp16 CoreML EP → cast fp16→fp32 → Decoder fp32 ORT CPU
/// → symbols → SMF + noteLayout.
///
/// Staff tile assumption: NCHW `[1,1,256,1280]` after `StaffInputSpec` normalize
/// (upstream `ConvertToArray` / `Config.max_height|max_width`).
///
/// SegNet tiling / full-page geometry are explicitly out of scope here.
public final class StaffInferenceSession: @unchecked Sendable {
    public let vocabulary: HomrVocabulary
    public let encoder: EncoderSession
    public let decoder: DecoderSession
    public let decoderLoop: DecoderLoop
    public let smfWriter: SMFWriter

    /// Sub-timings of the last `decodeStaff` call (replaces bare lastEncoderMs/lastDecoderMs).
    public internal(set) var lastTiming = StaffDecodeTiming()

    /// Compatibility: encoder ms from `lastTiming` (prefer `lastTiming` for new code).
    public var lastEncoderMs: Double { lastTiming.encoderMs }
    /// Compatibility: decoder ms from `lastTiming` (prefer `lastTiming` for new code).
    public var lastDecoderMs: Double { lastTiming.decoderMs }

    public init(
        vocabulary: HomrVocabulary,
        encoder: EncoderSession,
        decoder: DecoderSession,
        smfWriter: SMFWriter = SMFWriter()
    ) {
        self.vocabulary = vocabulary
        self.encoder = encoder
        self.decoder = decoder
        self.decoderLoop = DecoderLoop(vocabulary: vocabulary)
        self.smfWriter = smfWriter
    }

    /// Default scaffold: load vocab + HF tokenizer presence check; models optional/missing.
    public static func makeDefault(bundle: Bundle? = nil) throws -> StaffInferenceSession {
        let vocab = try TokenizerLoader.loadVocabulary(bundle: bundle)
        _ = try TokenizerLoader.requireHFTokenizerAssets(bundle: bundle)
        let encoder = EncoderSession(modelURL: nil)
        let decoder = DecoderSession(vocabulary: vocab, modelURL: nil)
        return StaffInferenceSession(vocabulary: vocab, encoder: encoder, decoder: decoder)
    }

    public func parse(input: ParseSheetMusicInput) throws -> ParseSheetMusicResult {
        guard input.staffOnly else {
            throw OMRError.staffOnlyGate1NotReady(
                "Full-page / SegNet path is out of scope for gate-1; set staffOnly=true"
            )
        }
        guard !input.imageData.isEmpty else {
            throw OMRError.staffOnlyGate1NotReady("Empty staff imageData")
        }

        // Intentionally do not fake model runs. Preserve clear Gate-1 error for app shell.
        throw OMRError.staffOnlyGate1NotReady(
            """
            Gate-1: tokenizer + decode-loop + SMF hooks ready; encoder/decoder ORT sessions and \
            C-scale oracle fixtures not yet wired. Staff input assumption NCHW \
            \(StaffInputSpec.nchwShape). Stop condition is staff-only C-scale oracle token match \
            before UI/geometry work.
            """
        )
    }

    /// Hook for oracle-driven token compare once fixtures + ORT step runner land.
    ///
    /// Casts encoder context fp16→fp32 at the seam, then runs `DecoderLoop.generate`.
    public func decodeStaffSymbols(
        normalizedStaffImage: Data,
        stepRunner: DecoderStepRunning
    ) throws -> [EncodedSymbol] {
        let context = try encoder.generateContext(staffImageNormalized: normalizedStaffImage)
        let fp32 = context.castToFP32ForDecoder()
        return try decoderLoop.generate(context: fp32, stepRunner: stepRunner)
    }

    /// Public oracle-facing sequence (field strings only — no invented vocab).
    public func decodeStaffOracleSequence(
        normalizedStaffImage: Data,
        stepRunner: DecoderStepRunning
    ) throws -> OracleSymbolSequence {
        let symbols = try decodeStaffSymbols(
            normalizedStaffImage: normalizedStaffImage,
            stepRunner: stepRunner
        )
        return OracleSymbolSequence(encoded: symbols)
    }
}
