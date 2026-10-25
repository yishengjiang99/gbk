import Foundation

/// Decoder session over a backend-neutral `ORTSessionBackend`.
///
/// Product rule (locked): Decoder runs on ORT **CPU only**, **fp32**, on every platform.
/// Never GPU / WebGPU / Metal / CoreML for the decoder; any provider other than `.cpu` is
/// rejected. Do not requantize the published decoder checkpoint.
///
/// Pinned model (models.lock): `decoder_pytorch_model_465-…onnx` (fp32). Real I/O (read from
/// the ONNX file):
/// - `rhythms`, `pitchs`, `lifts`, `articulations`, `slurs`: int64 `[1, 1]`
/// - `context`: float32 `[1, cache_exists, 512]` (full `[1,1280,512]` on step 0, else `[:, :1]`)
/// - `cache_len`: int64 `[1]` (= step)
/// - `cache_in0` … `cache_in31`: float32 `[1, 8, seq_len, 64]` (`decoder_depth * 4`)
/// - outputs `out_rhythms [1,1,260]`, `out_pitchs [1,1,72]`, `out_lifts [1,1,7]`,
///   `out_positions [1,1,5]`, `out_articulations [1,1,62]`, `out_slurs [1,1,5]`,
///   `attention [2]`, `cache_out0` … `cache_out31`.
///
/// Mirrors `homr/transformer/decoder_inference.py` `ScoreDecoder` (`init_cache` + `generate`).
public final class DecoderSession: @unchecked Sendable {
    public let vocabulary: HomrVocabulary
    public let modelURL: URL?
    public private(set) var isConfigured: Bool
    /// Bound ORT backend (always a `.cpu` session). Nil in the scaffold.
    public private(set) var backend: (any ORTSessionBackend)?

    /// Locked: CPU only.
    public let executionProvider = "CPUExecutionProvider"

    /// Scaffold initializer (no backend).
    public init(vocabulary: HomrVocabulary, modelURL: URL? = nil) {
        self.vocabulary = vocabulary
        self.modelURL = modelURL
        self.isConfigured = false
    }

    /// Bind a backend. Throws unless `provider == .cpu` and the model exposes every step
    /// input / output upstream binds (including all `cache_in*` / `cache_out*`).
    public init(
        vocabulary: HomrVocabulary,
        backend: any ORTSessionBackend,
        provider: ORTProvider,
        modelURL: URL? = nil
    ) throws {
        guard provider == .cpu else {
            throw OMRError.sessionNotConfigured(
                "Decoder is locked to ORT CPU fp32; refusing provider \(provider)"
            )
        }
        if let actual = (backend as? any ORTProviderReporting)?.provider, actual != .cpu {
            throw OMRError.sessionNotConfigured(
                "Decoder is locked to ORT CPU fp32; backend session was created with provider \(actual)"
            )
        }
        let d = DecoderSession(vocabulary: vocabulary)
        let missingIn = d.stepInputNames.filter { !backend.inputNames.contains($0) }
        let missingOut = d.stepOutputNames.filter { !backend.outputNames.contains($0) }
        guard missingIn.isEmpty, missingOut.isEmpty else {
            throw OMRError.sessionNotConfigured(
                "Decoder model I/O mismatch: missing inputs \(missingIn), missing outputs \(missingOut)"
            )
        }
        self.vocabulary = vocabulary
        self.modelURL = modelURL
        self.isConfigured = true
        self.backend = backend
    }

    /// Open the fp32 decoder on the CPU EP (the only provider allowed).
    public static func open<B: ORTSessionBackend>(
        _ backendType: B.Type,
        vocabulary: HomrVocabulary,
        modelURL: URL
    ) throws -> DecoderSession {
        let b = try B(modelURL: modelURL, provider: .cpu)
        return try DecoderSession(vocabulary: vocabulary, backend: b, provider: .cpu, modelURL: modelURL)
    }

    /// Kept for app warm-up: succeeds when a backend is bound, else throws the scaffold error.
    public func configureStub() throws {
        if backend != nil { return }
        guard let modelURL else {
            throw OMRError.modelsNotBundled(
                "Decoder fp32 ONNX not bundled. Run scripts/fetch-models (liebharc/homr onnx_checkpoints). Do not requantize."
            )
        }
        _ = modelURL
        throw OMRError.sessionNotConfigured(
            "No ORTSessionBackend bound; use DecoderSession.open(_:vocabulary:modelURL:) (CPU only)"
        )
    }

    /// Token / context inputs of one step (upstream `bind_cpu_input` order).
    public static let inputNames = [
        "rhythms", "pitchs", "lifts", "articulations", "slurs", "context", "cache_len",
    ]
    /// Non-cache outputs, upstream `ScoreDecoder.output_names` order.
    public static let outputNames = [
        "out_rhythms", "out_pitchs", "out_lifts", "out_positions",
        "out_articulations", "out_slurs", "attention",
    ]

    /// Config knobs mirrored from `homr.transformer.configs.Config` (match the ONNX file).
    public var decoderDepth: Int { 8 }
    public var decoderHeads: Int { 8 }
    public var decoderDim: Int { 512 }
    public var headDim: Int { decoderDim / decoderHeads }
    /// `decoder_depth * 4` — self/cross K/V per layer (upstream `init_cache`).
    public var kvCacheTensorCount: Int { decoderDepth * 4 }

    /// `cache_in0` … `cache_in{N-1}` (upstream `init_cache` input names).
    public var cacheInputNames: [String] { (0..<kvCacheTensorCount).map { "cache_in\($0)" } }
    /// `cache_out0` … `cache_out{N-1}`; outputs[7:] upstream.
    public var cacheOutputNames: [String] { (0..<kvCacheTensorCount).map { "cache_out\($0)" } }
    /// Every input one step binds.
    public var stepInputNames: [String] { Self.inputNames + cacheInputNames }
    /// Every output one step requests (upstream `output_names + kv_output_names`).
    public var stepOutputNames: [String] { Self.outputNames + cacheOutputNames }

    /// Empty KV cache shapes for `cache_len == 0` (start of generate).
    public func initialCacheShapes(cacheLen: Int = 0) -> [[Int]] {
        let shape = [1, decoderHeads, cacheLen, headDim]
        return Array(repeating: shape, count: kvCacheTensorCount)
    }

    /// Stateful step runner for one `DecoderLoop.generate` call over `context`.
    ///
    /// `context` must already be fp32 (`EncoderContext.castToFP32ForDecoder()`); fp16 is refused.
    public func makeStepRunner(context: EncoderContext) throws -> ORTDecoderStepRunner {
        guard let backend else {
            throw OMRError.sessionNotConfigured("DecoderSession has no ORTSessionBackend bound")
        }
        return try ORTDecoderStepRunner(session: self, backend: backend, context: context)
    }
}

/// Decoder zero-copy / step timing (filled by `ORTBoundDecoderRunner` when ORT is linked).
public struct DecoderBoundMetrics: Sendable, Equatable {
    public var totalDecoderMs: Double = 0
    public var ortInferenceMs: Double = 0
    public var bindingSetupMs: Double = 0
    public var argmaxMs: Double = 0
    public var tokenCount: Int = 0
    public var cacheBytesCopiedThroughSwift: Int = 0
    public var nativeCacheRebinds: Int = 0
    public var perTokenMs: [Double] = []

    public init(
        totalDecoderMs: Double = 0, ortInferenceMs: Double = 0, bindingSetupMs: Double = 0,
        argmaxMs: Double = 0, tokenCount: Int = 0, cacheBytesCopiedThroughSwift: Int = 0,
        nativeCacheRebinds: Int = 0, perTokenMs: [Double] = []
    ) {
        self.totalDecoderMs = totalDecoderMs
        self.ortInferenceMs = ortInferenceMs
        self.bindingSetupMs = bindingSetupMs
        self.argmaxMs = argmaxMs
        self.tokenCount = tokenCount
        self.cacheBytesCopiedThroughSwift = cacheBytesCopiedThroughSwift
        self.nativeCacheRebinds = nativeCacheRebinds
        self.perTokenMs = perTokenMs
    }

    public var avgTokenMs: Double {
        guard !perTokenMs.isEmpty else { return 0 }
        return perTokenMs.reduce(0, +) / Double(perTokenMs.count)
    }
    public var p50TokenMs: Double { Self.percentile(perTokenMs, 0.50) }
    public var p95TokenMs: Double { Self.percentile(perTokenMs, 0.95) }
    static func percentile(_ xs: [Double], _ p: Double) -> Double {
        guard !xs.isEmpty else { return 0 }
        let s = xs.sorted()
        let i = min(s.count - 1, max(0, Int((Double(s.count - 1) * p).rounded())))
        return s[i]
    }
}

/// `DecoderStepRunning` over a real ORT decoder session (CPU fp32).
///
/// Default path (when the backend is `ORTCSession` and `OMR_DECODER_GENERIC` is unset/`0`):
/// zero-copy KV-cache via ORT I/O Binding (`ORTBoundDecoderRunner`) — caches stay as native
/// `OrtValue`s and are rebound as `cache_in*` without Swift `Data` materialization.
///
/// Generic path (`backend.run` + `Data` copy of every cache every step): kept for parity tests
/// and non-`ORTCSession` backends. Force with env `OMR_DECODER_GENERIC=1` or
/// `ORTDecoderStepRunner.forceGenericPath = true`.
///
/// Per step, exactly as upstream `ScoreDecoder.generate`:
/// - binds the five token ids as int64 `[1,1]`, `context` (full on step 0, else `context[:, :1]`),
///   `cache_len = [step]` int64, and `cache_in*` (zero-length `[1,8,0,64]` fp32 on step 0, then the
///   previous step's `cache_out*`);
/// - greedy argmax of `out_*[:, -1, :]` (first maximum wins, like NumPy);
/// - forwards the raw `attention` bytes as `attentionBlob`.
///
/// Not thread-safe: one runner per decode. `cacheLen == 0` resets the KV cache.
public final class ORTDecoderStepRunner: DecoderStepRunning, @unchecked Sendable {
    /// When true, always use the generic `ORTSessionBackend.run` path (alloc+copy caches).
    /// Also enabled when env `OMR_DECODER_GENERIC=1`.
    public static var forceGenericPath: Bool = false

    public static var preferZeroCopy: Bool {
        if forceGenericPath { return false }
        if ProcessInfo.processInfo.environment["OMR_DECODER_GENERIC"] == "1" { return false }
        return true
    }

    private let backend: any ORTSessionBackend
    private let fullContext: ORTTensor
    private let reducedContext: ORTTensor
    private let cacheInputNames: [String]
    private let cacheOutputNames: [String]
    private let stepOutputNames: [String]
    private let emptyCache: [ORTTensor]
    private var cache: [ORTTensor]
    #if canImport(CONNXRuntime) || canImport(CONNXRuntimeApple)
    private let bound: ORTBoundDecoderRunner?
    #endif

    /// Metrics from the zero-copy path (nil when using the generic path).
    public var boundMetrics: DecoderBoundMetrics? {
        #if canImport(CONNXRuntime) || canImport(CONNXRuntimeApple)
        guard let m = bound?.metrics else { return nil }
        return DecoderBoundMetrics(
            totalDecoderMs: m.totalDecoderMs, ortInferenceMs: m.ortInferenceMs,
            bindingSetupMs: m.bindingSetupMs, argmaxMs: m.argmaxMs, tokenCount: m.tokenCount,
            cacheBytesCopiedThroughSwift: m.cacheBytesCopiedThroughSwift,
            nativeCacheRebinds: m.nativeCacheRebinds, perTokenMs: m.perTokenMs
        )
        #else
        return nil
        #endif
    }

    init(session: DecoderSession, backend: any ORTSessionBackend, context: EncoderContext) throws {
        guard context.dtype == .float32 else {
            throw OMRError.sessionNotConfigured(
                "Decoder context must be fp32 (call castToFP32ForDecoder()); got \(context.dtype.rawValue)"
            )
        }
        let s = context.shape
        guard s.count == 3, s[0] == 1, s[1] >= 1, s[2] == session.decoderDim,
              context.bytes.count == s.reduce(1, *) * 4 else {
            throw OMRError.sessionNotConfigured(
                "Decoder context shape \(s) / \(context.bytes.count) bytes is not fp32 [1, seq, \(session.decoderDim)]"
            )
        }
        self.backend = backend
        self.fullContext = ORTTensor(type: .float32, shape: s, data: context.bytes)
        // Python: context_reduced = context[:, :1]  (batch 1 → the first row of `dim` floats)
        self.reducedContext = ORTTensor(
            type: .float32, shape: [1, 1, s[2]], data: context.bytes.prefix(s[2] * 4)
        )
        self.cacheInputNames = session.cacheInputNames
        self.cacheOutputNames = session.cacheOutputNames
        self.stepOutputNames = session.stepOutputNames
        self.emptyCache = session.initialCacheShapes(cacheLen: 0).map {
            ORTTensor(type: .float32, shape: $0, data: Data())
        }
        self.cache = emptyCache

        #if canImport(CONNXRuntime) || canImport(CONNXRuntimeApple)
        if Self.preferZeroCopy, let ort = backend as? ORTCSession {
            self.bound = try ORTBoundDecoderRunner(ort: ort, context: context, session: session)
        } else {
            self.bound = nil
        }
        #endif
    }

    public func runStep(_ input: DecoderStepInput) throws -> DecoderStepOutput {
        #if canImport(CONNXRuntime) || canImport(CONNXRuntimeApple)
        if let bound {
            return try bound.runStep(input)
        }
        #endif
        return try runStepGeneric(input)
    }

    /// Old path: every cache tensor is copied through Swift `Data` via `ORTCSession.run`.
    func runStepGeneric(_ input: DecoderStepInput) throws -> DecoderStepOutput {
        if input.cacheLen == 0 { cache = emptyCache }
        func ids(_ v: Int) -> ORTTensor {
            ORTTensor(type: .int64, shape: [1, 1], data: Self.int64Data([Int64(v)]))
        }
        var feeds: [String: ORTTensor] = [
            "rhythms": ids(input.rhythm),
            "pitchs": ids(input.pitch),
            "lifts": ids(input.lift),
            "articulations": ids(input.articulation),
            "slurs": ids(input.slur),
            "context": input.useFullContext ? fullContext : reducedContext,
            "cache_len": ORTTensor(type: .int64, shape: [1], data: Self.int64Data([Int64(input.cacheLen)])),
        ]
        for (name, value) in zip(cacheInputNames, cache) { feeds[name] = value }

        let out = try backend.run(inputs: feeds, outputNames: stepOutputNames)

        var nextCache: [ORTTensor] = []
        nextCache.reserveCapacity(cacheOutputNames.count)
        for name in cacheOutputNames {
            guard let t = out[name] else {
                throw OMRError.sessionNotConfigured("Decoder step \(input.stepIndex): missing \(name)")
            }
            nextCache.append(t)
        }
        cache = nextCache

        func head(_ name: String) throws -> Int {
            guard let t = out[name] else {
                throw OMRError.sessionNotConfigured("Decoder step \(input.stepIndex): missing \(name)")
            }
            return try Self.argmaxLastRow(t, name: name)
        }
        return DecoderStepOutput(
            rhythmArgmax: try head("out_rhythms"),
            pitchArgmax: try head("out_pitchs"),
            liftArgmax: try head("out_lifts"),
            positionArgmax: try head("out_positions"),
            articulationArgmax: try head("out_articulations"),
            slurArgmax: try head("out_slurs"),
            attentionBlob: out["attention"]?.data
        )
    }

    /// NumPy `x[:, -1, :].argmax()` for a float32 `[1, T, V]` logits tensor (batch 1).
    /// First maximum wins; a NaN wins like in NumPy.
    static func argmaxLastRow(_ t: ORTTensor, name: String) throws -> Int {
        guard t.type == .float32, let v = t.shape.last, v > 0 else {
            throw OMRError.sessionNotConfigured("\(name): expected float32 [1,T,V] logits, got \(t.type) \(t.shape)")
        }
        let total = t.shape.reduce(1, *)
        guard t.data.count == total * 4, total >= v else {
            throw OMRError.sessionNotConfigured("\(name): \(t.data.count) bytes for shape \(t.shape)")
        }
        let start = (total - v) * 4
        return t.data.withUnsafeBytes { raw -> Int in
            var best = 0
            var bestValue = -Float.infinity
            for i in 0..<v {
                let bits = raw.loadUnaligned(fromByteOffset: start + i * 4, as: UInt32.self)
                let x = Float(bitPattern: UInt32(littleEndian: bits))
                if x.isNaN { return i }
                if i == 0 || x > bestValue {
                    best = i
                    bestValue = x
                }
            }
            return best
        }
    }

    static func int64Data(_ values: [Int64]) -> Data {
        var d = Data(capacity: values.count * 8)
        for v in values {
            withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) }
        }
        return d
    }
}
