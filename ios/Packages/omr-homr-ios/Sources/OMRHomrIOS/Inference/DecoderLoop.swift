import Foundation

/// Staff-only decoder token loop structured to mirror
/// `homr/transformer/decoder_inference.py` `ScoreDecoder.generate`.
///
/// Step order (locked to upstream):
/// 1. Take last token from each stream (`[:, -1:]`)
/// 2. `context` full on step 0, else `context[:, :1]` (`context_reduced`)
/// 3. Bind rhythms/pitchs/lifts/articulations/slurs/context/`cache_len=step`
/// 4. Greedy argmax on each head (`[:, -1, :].argmax()`)
/// 5. Stop when rhythm argmax == `eos_token` (do not emit EOS)
/// 6. Detokenize via inv vocab (skip BOS/EOS/PAD and bracketed forms)
/// 7. Append `EncodedSymbol`, concatenate samples onto streams
///
/// Gate-1 stop condition: C-scale staff oracle token match (fixture-driven).
/// ORT step execution is intentionally not faked (`UnconfiguredDecoderStepRunner`).
public struct DecoderLoop: Sendable {
    public let vocabulary: HomrVocabulary

    public init(vocabulary: HomrVocabulary) {
        self.vocabulary = vocabulary
    }

    /// Mirrors Python `generate(start_tokens, nonote_tokens, context=...)`.
    ///
    /// Upstream `Staff2Score.predict` seeds:
    /// - `start_token = [[bos_token]]` (Config.bos_token == 1) on the rhythm stream
    /// - `nonote_token = [[0]]` on pitch/lift/articulation/slur streams
    ///
    /// Context must already be cast to decoder dtype (fp32 on the locked CPU path)
    /// — see `EncoderContext.castToFP32ForDecoder()` / `staff2score.py`.
    public func generate(
        startRhythmToken: Int? = nil,
        nonoteToken: Int? = nil,
        context: EncoderContext,
        stepRunner: DecoderStepRunning
    ) throws -> [EncodedSymbol] {
        let bos = startRhythmToken ?? vocabulary.bosToken
        let nonote = nonoteToken ?? vocabulary.nonoteToken

        // Product rule: decoder ORT CPU is fp32. Refuse fp16 context at the seam.
        guard context.dtype == .float32 else {
            throw OMRError.sessionNotConfigured(
                "DecoderLoop expects fp32 context (cast encoder fp16→fp32 before generate); got \(context.dtype.rawValue)"
            )
        }

        var outRhythm: [Int] = [bos]
        var outPitch: [Int] = [nonote]
        var outLift: [Int] = [nonote]
        var outArticulations: [Int] = [nonote]
        var outSlurs: [Int] = [nonote]

        var symbols: [EncodedSymbol] = []
        let maxLen = vocabulary.maxSeqLen

        for step in 0..<maxLen {
            // Python: x_* = out_*[:, -1:]  shape (1,1)
            let xRhythm = outRhythm[outRhythm.count - 1]
            let xPitch = outPitch[outPitch.count - 1]
            let xLift = outLift[outLift.count - 1]
            let xArticulations = outArticulations[outArticulations.count - 1]
            let xSlurs = outSlurs[outSlurs.count - 1]

            // Python: context = context if step == 0 else context_reduced (context[:, :1])
            let useFullContext = (step == 0)

            let stepOut = try stepRunner.runStep(
                DecoderStepInput(
                    stepIndex: step,
                    cacheLen: step,
                    rhythm: xRhythm,
                    pitch: xPitch,
                    lift: xLift,
                    articulation: xArticulations,
                    slur: xSlurs,
                    useFullContext: useFullContext,
                    contextDtype: context.dtype,
                    contextShape: context.shape
                )
            )

            let rhythmSample = stepOut.rhythmArgmax
            let pitchSample = stepOut.pitchArgmax
            let liftSample = stepOut.liftArgmax
            let articulationSample = stepOut.articulationArgmax
            let slurSample = stepOut.slurArgmax
            let positionSample = stepOut.positionArgmax

            // Python: if rhythm_sample == eos_token: break  (before appending symbol/streams)
            if rhythmSample == vocabulary.eosToken {
                break
            }

            // Python detokenize order is independent; filter BOS/EOS/PAD.
            guard let rhythmTok = Self.detokenize(rhythmSample, vocabulary.invRhythm) else {
                // Upstream would KeyError / empty-list index on unknown/control rhythm.
                // Refuse to invent a rhythm string.
                throw OMRError.invalidVocabulary(
                    "Decoder rhythm id \(rhythmSample) missing or control after non-EOS step \(step)"
                )
            }

            let pitchTok = Self.detokenize(pitchSample, vocabulary.invPitch) ?? EncodedSymbol.nonote
            let liftTok = Self.detokenize(liftSample, vocabulary.invLift) ?? EncodedSymbol.nonote
            let articulationTok =
                Self.detokenize(articulationSample, vocabulary.invArticulation) ?? EncodedSymbol.nonote
            let slurTok = Self.detokenize(slurSample, vocabulary.invSlur) ?? EncodedSymbol.nonote
            let positionTok =
                Self.detokenize(positionSample, vocabulary.invPosition) ?? EncodedSymbol.nonote

            symbols.append(
                EncodedSymbol(
                    rhythm: rhythmTok,
                    pitch: pitchTok,
                    lift: liftTok,
                    articulation: articulationTok,
                    slur: slurTok,
                    position: positionTok,
                    attentionPayload: stepOut.attentionBlob
                )
            )

            // Python concatenate axis=-1 after append
            outLift.append(liftSample)
            outPitch.append(pitchSample)
            outRhythm.append(rhythmSample)
            outArticulations.append(articulationSample)
            outSlurs.append(slurSample)
        }

        return symbols
    }

    /// Mirrors `detokenize` in decoder_inference.py (skip BOS/EOS/PAD and bracketed forms).
    public static func detokenize(_ id: Int, _ inv: [Int: String]) -> String? {
        guard let t = inv[id] else { return nil }
        if t == "BOS" || t == "EOS" || t == "PAD" { return nil }
        if t == "[BOS]" || t == "[EOS]" || t == "[PAD]" { return nil }
        return t
    }
}

public struct DecoderStepInput: Sendable {
    /// Zero-based decode step; equals Python loop `step`.
    public var stepIndex: Int
    /// Bound as ONNX `cache_len` — upstream passes `np.array([step], dtype=np.int64)`.
    public var cacheLen: Int
    public var rhythm: Int
    public var pitch: Int
    public var lift: Int
    public var articulation: Int
    public var slur: Int
    /// `true` only on step 0 (full encoder context); later steps use `context[:, :1]`.
    public var useFullContext: Bool
    /// Expected `.float32` on the locked Decoder CPU path.
    public var contextDtype: EncoderContext.ContextDType
    /// Encoder context logical shape when known (empty until ORT binding fills it).
    public var contextShape: [Int]

    public init(
        stepIndex: Int,
        cacheLen: Int? = nil,
        rhythm: Int,
        pitch: Int,
        lift: Int,
        articulation: Int,
        slur: Int,
        useFullContext: Bool,
        contextDtype: EncoderContext.ContextDType = .float32,
        contextShape: [Int] = []
    ) {
        self.stepIndex = stepIndex
        self.cacheLen = cacheLen ?? stepIndex
        self.rhythm = rhythm
        self.pitch = pitch
        self.lift = lift
        self.articulation = articulation
        self.slur = slur
        self.useFullContext = useFullContext
        self.contextDtype = contextDtype
        self.contextShape = contextShape
    }
}

public struct DecoderStepOutput: Sendable {
    public var rhythmArgmax: Int
    public var pitchArgmax: Int
    public var liftArgmax: Int
    public var positionArgmax: Int
    public var articulationArgmax: Int
    public var slurArgmax: Int
    public var attentionBlob: Data?

    public init(
        rhythmArgmax: Int,
        pitchArgmax: Int,
        liftArgmax: Int,
        positionArgmax: Int,
        articulationArgmax: Int,
        slurArgmax: Int,
        attentionBlob: Data? = nil
    ) {
        self.rhythmArgmax = rhythmArgmax
        self.pitchArgmax = pitchArgmax
        self.liftArgmax = liftArgmax
        self.positionArgmax = positionArgmax
        self.articulationArgmax = articulationArgmax
        self.slurArgmax = slurArgmax
        self.attentionBlob = attentionBlob
    }
}

public protocol DecoderStepRunning: Sendable {
    func runStep(_ input: DecoderStepInput) throws -> DecoderStepOutput
}

/// Scaffold runner: refuses to invent logits. Replace with ORT CPU binding.
public struct UnconfiguredDecoderStepRunner: DecoderStepRunning {
    public init() {}
    public func runStep(_ input: DecoderStepInput) throws -> DecoderStepOutput {
        throw OMRError.sessionNotConfigured(
            "Decoder ORT CPU step not bound (step \(input.stepIndex), cache_len=\(input.cacheLen)); refusing to fake logits"
        )
    }
}
