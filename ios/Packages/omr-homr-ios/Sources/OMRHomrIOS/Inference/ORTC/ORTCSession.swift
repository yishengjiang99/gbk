#if canImport(CONNXRuntime)
internal import CONNXRuntime
#elseif canImport(CONNXRuntimeApple)
internal import CONNXRuntimeApple
#endif

// Platform-independent (also used by `CoreMLModelCache.validate`), so declared outside the ORT gate.
/// Errors raised by `ORTCSession`.
public enum ORTCError: Error, CustomStringConvertible, Sendable {
    /// Provider not available on this platform (`.coreML` on Linux, which is CPU EP only).
    case unsupportedProvider(String)
    /// `OrtGetApiBase()->GetApi(ORT_API_VERSION)` returned NULL (header/library mismatch).
    case apiUnavailable(requested: Int, library: String)
    /// An `OrtStatus` error returned by the C API.
    case ort(code: Int, message: String, call: String)
    /// Input/output tensor does not match its declared shape or element type.
    case invalidTensor(String)
    /// Model uses an element type outside float32/float16/int64/int32.
    case unsupportedElementType(name: String, onnxType: Int)
    /// Requested input/output name is not part of the model.
    case unknownName(String)
    /// Bad CoreML compiled-model cache arguments (`cacheDirectory` with `.cpu`, invalid `cacheKey`, …).
    case invalidCacheConfiguration(String)

    public var description: String {
        switch self {
        case let .unsupportedProvider(p): return "ORTCSession: provider \(p) not supported on this platform (Linux: CPU EP only)"
        case let .apiUnavailable(v, lib): return "ORTCSession: ORT C API v\(v) unavailable in libonnxruntime \(lib)"
        case let .ort(code, msg, call): return "ORTCSession: \(call) failed (OrtErrorCode \(code)): \(msg)"
        case let .invalidTensor(m): return "ORTCSession: invalid tensor: \(m)"
        case let .unsupportedElementType(n, t): return "ORTCSession: '\(n)' has unsupported ONNX element type \(t)"
        case let .unknownName(n): return "ORTCSession: unknown input/output name '\(n)'"
        case let .invalidCacheConfiguration(m): return "ORTCSession: invalid CoreML cache configuration: \(m)"
        }
    }
}

#if canImport(CONNXRuntime) || canImport(CONNXRuntimeApple)
import Foundation

// ONNX Runtime C-API backend for `ORTSessionBackend` (see ORTBackend.swift), on BOTH platforms:
// - Linux: `CONNXRuntime` system library over the official libonnxruntime fetched by
//   scripts/fetch-ort (ort.lock, 1.30.0). CPU execution provider ONLY; `.coreML` throws.
// - iOS / macOS: `CONNXRuntimeApple` (C headers of the onnxruntime.xcframework shipped by
//   microsoft/onnxruntime-swift-package-manager, pinned in Package.swift). `.cpu` = default CPU EP;
//   `.coreML` = `OrtSessionOptionsAppendExecutionProvider_CoreML` (MLProgram, CPU+GPU) with the CPU
//   EP still registered as fallback; with a `cacheDirectory`, the provider-options API with the same
//   format / compute units + `ModelCacheDirectory`, model loaded from bytes with `COREML_CACHE_KEY`
//   (see `CoreMLModelCache`). Built and tested on macOS CI (ios-sim workflow). `.coreML` is for
//   encoder / SegNet sessions only: `DecoderSession` rejects any backend whose provider is not `.cpu`.
//   SegNet must NOT use these MLProgram defaults (all-zero output on ORT 1.24.2): open it with
//   `SegNetSession.openBackend(modelURL:provider:cacheDirectory:)` (NeuralNetwork, legacy flags 0x000).
// - Moves RAW little-endian, row-major bytes tagged with their element type (float32, float16 via
//   ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16, int64, int32). It never converts dtypes; the single
//   fp16 -> fp32 cast lives in `EncoderContext.castToFP32ForDecoder()`.

/// Process-wide ORT API table + `OrtEnv` (ORT recommends one env per process).
final class ORTCRuntime: @unchecked Sendable {
    let api: OrtApi
    let env: OpaquePointer

    static let shared: Result<ORTCRuntime, Error> = Result { try ORTCRuntime() }

    private init() throws {
        guard let base = OrtGetApiBase() else {
            throw ORTCError.apiUnavailable(requested: Int(ORT_API_VERSION), library: "?")
        }
        let libVersion = base.pointee.GetVersionString.flatMap { $0() }.map { String(cString: $0) } ?? "?"
        guard let apiPtr = base.pointee.GetApi!(UInt32(ORT_API_VERSION)) else {
            throw ORTCError.apiUnavailable(requested: Int(ORT_API_VERSION), library: libVersion)
        }
        api = apiPtr.pointee
        var envOut: OpaquePointer?
        try ORTCRuntime.check(api, api.CreateEnv!(ORT_LOGGING_LEVEL_WARNING, "omr-ortc", &envOut), "CreateEnv")
        guard let envOut else { throw ORTCError.ort(code: -1, message: "null OrtEnv", call: "CreateEnv") }
        env = envOut
        // Intentionally never released: lives for the process, shared by all sessions.
    }

    /// Converts a non-NULL `OrtStatus*` into a thrown `ORTCError.ort`, releasing the status.
    static func check(_ api: OrtApi, _ status: OpaquePointer?, _ call: String) throws {
        guard let status else { return }
        let message = api.GetErrorMessage!(status).map { String(cString: $0) } ?? "unknown error"
        let code = Int(api.GetErrorCode!(status).rawValue)
        api.ReleaseStatus!(status)
        throw ORTCError.ort(code: code, message: message, call: call)
    }
}

/// ONNX Runtime session via the C API. `.cpu` everywhere; `.coreML` (+ CPU fallback) on Apple only.
///
/// ```swift
/// let dec = try ORTCSession(modelURL: decoderURL, provider: .cpu)
/// // Encoder / SegNet on Apple, with the app-owned CoreML cache folder for this model:
/// let enc = try ORTCSession(modelURL: encoderURL, provider: .coreML, cacheDirectory: cacheDir)
/// let out = try dec.run(inputs: ["rhythms": ORTTensor(type: .int64, shape: [1, 1], data: ...), ...],
///                       outputNames: ["out_rhythms"])
/// ```
public final class ORTCSession: ORTSessionBackend, ORTCoreMLCacheableBackend, ORTProviderReporting, @unchecked Sendable {
    /// Declared model input/output (ONNX metadata). Dynamic dims are `-1` in `shape`,
    /// with their symbolic name (if any) in `symbolicShape`.
    public struct IOInfo: Sendable, CustomStringConvertible {
        public let name: String
        /// `nil` when the model declares a type outside float32/float16/int64/int32.
        public let elementType: ORTElementType?
        /// Raw `ONNXTensorElementDataType` value (1 = float, 10 = float16, 7 = int64, 6 = int32, ...).
        public let onnxElementType: Int
        public let shape: [Int]
        public let symbolicShape: [String]

        public var description: String {
            let dims = zip(shape, symbolicShape).map { d, s in d >= 0 ? String(d) : (s.isEmpty ? "?" : s) }
            let t = elementType.map { "\($0)" } ?? "onnx#\(onnxElementType)"
            return "\(name): \(t) [\(dims.joined(separator: ", "))]"
        }
    }

    public let modelURL: URL
    /// Provider this session was created with (`.coreML` only on Apple; Linux is always `.cpu`).
    public let provider: ORTProvider
    /// CoreML compiled-model cache folder (`ModelCacheDirectory`); nil = no cache (temp dir, deleted).
    public let coreMLCacheDirectory: URL?
    /// `COREML_CACHE_KEY` embedded in the model for the CoreML cache (nil when opened by path).
    /// ORT's cache entry is `<coreMLCacheDirectory>/<coreMLCacheKey>/`.
    public let coreMLCacheKey: String?
    /// CoreML EP model format this session asked for: `"MLProgram"` or `"NeuralNetwork"`; nil for `.cpu`.
    /// SegNet = `"NeuralNetwork"` (`SegNetSession.coreMLLegacyFlags`), encoder = `"MLProgram"`. For diagnostics.
    public let coreMLModelFormat: String?
    public let inputNames: [String]
    public let outputNames: [String]
    public let inputInfo: [IOInfo]
    public let outputInfo: [IOInfo]

    let runtime: ORTCRuntime
    let session: OpaquePointer
    let memoryInfo: OpaquePointer

    /// `libonnxruntime` version string, e.g. "1.24.2".
    public static var runtimeVersion: String {
        guard let base = OrtGetApiBase(), let f = base.pointee.GetVersionString else { return "?" }
        return f().map { String(cString: $0) } ?? "?"
    }

    /// Intra-op threads used by `init(modelURL:provider:)` / `init(modelURL:provider:cacheDirectory:cacheKey:)`: `OMR_ORT_INTRA_OP_THREADS` if set, else 1.
    ///
    /// Default is 1 for determinism: with ORT's default multi-threaded intra-op pool the homr decoder
    /// gave run-to-run different logits for identical inputs (seen in Swift and in Python ORT 1.30),
    /// which breaks exact-token oracle gates. Single-threaded runs matched Python homr exactly.
    public static var defaultIntraOpThreads: Int {
        ProcessInfo.processInfo.environment["OMR_ORT_INTRA_OP_THREADS"].flatMap { Int($0) } ?? 1
    }

    /// `ORTSessionBackend` entry point. On Linux throws unless `provider == .cpu`.
    public convenience init(modelURL: URL, provider: ORTProvider) throws {
        try self.init(modelURL: modelURL, provider: provider, intraOpThreads: Self.defaultIntraOpThreads)
    }

    /// Session with an optional CoreML compiled-model cache.
    ///
    /// - Parameters:
    ///   - provider: `.cpu` (decoder; also encoder / SegNet on Linux) or `.coreML` (encoder / SegNet on
    ///     Apple; CPU EP stays registered as fallback). The decoder is fp32 on ORT CPU only and must never
    ///     get a cache (`DecoderSession` rejects non-CPU backends).
    ///   - cacheDirectory: `nil` (default) = exactly the old behaviour: legacy
    ///     `OrtSessionOptionsAppendExecutionProvider_CoreML(MLProgram | CPUAndGPU)`, model opened by path,
    ///     CoreML model compiled into a temp dir and deleted with the session. Non-nil (`.coreML` only;
    ///     `.cpu` throws `ORTCError.invalidCacheConfiguration`) = CoreML EP via the provider-options API
    ///     (`ModelFormat=MLProgram`, `MLComputeUnits=CPUAndGPU`, `ModelCacheDirectory=<path>`); ORT writes the
    ///     converted + compiled model to `<cacheDirectory>/<cacheKey>/…` and reuses it on the next launch.
    ///   - cacheKey: `COREML_CACHE_KEY` for this model; default = SHA-256 hex of the model file, computed
    ///     here (≈26–29 MB read). Pass the `models.lock` SHA-256 to skip the hash. Must be 1…64 ASCII
    ///     letters / digits (ORT's rule); only valid together with `cacheDirectory`.
    ///
    /// Cache facts (ORT v1.24.2 `onnxruntime/core/providers/coreml/`), which the CALLER must handle:
    /// - ORT does NOT invalidate the cache when the model changes: whatever sits under
    ///   `<cacheDirectory>/<cacheKey>/` is reused blindly. Hence one folder per model content, e.g. the
    ///   app's `<AppSupport>/coreml-cache/<sha256>/`, and a content key (the default).
    /// - The key never depends on the model's path: without `COREML_CACHE_KEY` ORT keys on a hash of the
    ///   file path, which changes with every iOS app update (container UUID) and would recompile (~30 s).
    ///   So with a cache the model is read into memory, `COREML_CACHE_KEY` is appended to its
    ///   `metadata_props` (a protobuf append; no other byte changes) and the session is created with
    ///   `CreateSessionFromArray`. Transient cost: one extra copy of the model file (~26–29 MB) during
    ///   session creation. Models must be single-file (no external data; true for the pinned models).
    /// - The directory need not exist: ORT `mkdir -p`s `<dir>/<key>/<id>_dynamic_mlprogram` itself. If that
    ///   fails (no write permission, read-only volume, EEXIST race) ORT logs an error and silently runs
    ///   WITHOUT a cache (session still works, compiles every time). Use a writable, non-bundle location.
    /// - The package never creates, deletes or cleans the folder. The owner (the app) handles backup
    ///   exclusion (`isExcludedFromBackup`), stale-key cleanup, and disk space (~model size per key).
    /// - A cache entry is "present" as soon as its folder exists. If the process dies mid-write (e.g. jetsam
    ///   during the first ~30 s compile) the half-written entry is reused next time and session creation
    ///   fails (CoreML compile error), every launch, until the folder is deleted. The owner should mark a
    ///   folder complete only after this initializer returns and delete incomplete folders before retrying.
    /// - Not safe to create two sessions for the SAME model + folder concurrently (both write the same
    ///   package; the loser's final move of `compiled_model.mlmodelc` fails and its init throws). Different
    ///   models / keys in one folder are fine (separate `<key>` subfolders). Serialize creation per model.
    public convenience init(
        modelURL: URL, provider: ORTProvider, cacheDirectory: URL? = nil, cacheKey: String? = nil
    ) throws {
        try self.init(
            modelURL: modelURL, provider: provider, intraOpThreads: Self.defaultIntraOpThreads,
            cacheDirectory: cacheDirectory, cacheKey: cacheKey
        )
    }

    /// - Parameter intraOpThreads: 0 = ORT default pool (one per physical core; NOT run-to-run
    ///   deterministic for the homr decoder), 1 = deterministic single-threaded.
    /// - Parameters cacheDirectory / cacheKey: see `init(modelURL:provider:cacheDirectory:cacheKey:)`.
    public convenience init(
        modelURL: URL, provider: ORTProvider, intraOpThreads: Int,
        cacheDirectory: URL? = nil, cacheKey: String? = nil
    ) throws {
        try CoreMLModelCache.validate(provider: provider, cacheDirectory: cacheDirectory, cacheKey: cacheKey)
        #if !canImport(CONNXRuntimeApple)
        guard case .cpu = provider else {
            throw ORTCError.unsupportedProvider("\(provider)")
        }
        #endif
        var plan = SessionPlan(provider: provider, intraOpThreads: intraOpThreads)
        if case .coreML = provider, let cacheDirectory {
            plan.coreMLProviderOptions = CoreMLModelCache.providerOptions(cacheDirectory: cacheDirectory)
            plan.cacheDirectory = cacheDirectory
            plan.embedCacheKey = .some(cacheKey)
        }
        try self.init(modelURL: modelURL, plan: plan)
    }

    /// How a session is built. Internal so tests can exercise the bytes + `COREML_CACHE_KEY` loading path
    /// on the CPU EP (Linux has no CoreML).
    struct SessionPlan {
        var provider: ORTProvider
        var intraOpThreads: Int
        /// Non-nil = CoreML EP via `SessionOptionsAppendExecutionProvider("CoreML", …)`; nil with `.coreML`
        /// = legacy flags.
        var coreMLProviderOptions: [(key: String, value: String)]?
        var cacheDirectory: URL?
        /// `.none` = open by path. `.some(key)` = load bytes, append `COREML_CACHE_KEY` = key (nil = file SHA-256).
        var embedCacheKey: String??
        /// `.coreML` without provider options: legacy flags (nil = `CoreMLModelCache.legacyCoreMLFlags`).
        var coreMLLegacyFlags: UInt32?
        /// `AddFreeDimensionOverrideByName` entries (e.g. `("batch_size", 1)` makes SegNet's input static).
        var freeDimensionOverrides: [(name: String, value: Int64)] = []
        /// `SetSessionLogSeverityLevel` (0 = verbose, 1 = info, 2 = warning …); nil = env default (warning).
        var logSeverity: Int32?

        init(provider: ORTProvider, intraOpThreads: Int) {
            self.provider = provider
            self.intraOpThreads = intraOpThreads
        }

        /// `"MLProgram"` / `"NeuralNetwork"` as ORT will build it; nil for `.cpu`.
        var coreMLModelFormat: String? {
            guard case .coreML = provider else { return nil }
            if let options = coreMLProviderOptions {
                // ORT's provider-options default is NeuralNetwork when ModelFormat is absent.
                return options.last { $0.key == CoreMLModelCache.modelFormatOption }?.value ?? "NeuralNetwork"
            }
            let flags = coreMLLegacyFlags ?? CoreMLModelCache.legacyCoreMLFlags
            return flags & CoreMLModelCache.createMLProgramFlag != 0 ? "MLProgram" : "NeuralNetwork"
        }
    }

    init(modelURL: URL, plan: SessionPlan) throws {
        let runtime = try ORTCRuntime.shared.get()
        let api = runtime.api
        self.runtime = runtime
        self.modelURL = modelURL
        self.provider = plan.provider
        self.coreMLCacheDirectory = plan.cacheDirectory
        self.coreMLModelFormat = plan.coreMLModelFormat

        var options: OpaquePointer?
        try ORTCRuntime.check(api, api.CreateSessionOptions!(&options), "CreateSessionOptions")
        defer { if let options { api.ReleaseSessionOptions!(options) } }
        try ORTCRuntime.check(
            api, api.SetIntraOpNumThreads!(options, Int32(plan.intraOpThreads)), "SetIntraOpNumThreads"
        )
        try ORTCRuntime.check(
            api, api.SetSessionGraphOptimizationLevel!(options, ORT_ENABLE_ALL), "SetSessionGraphOptimizationLevel"
        )
        if let severity = plan.logSeverity {
            try ORTCRuntime.check(api, api.SetSessionLogSeverityLevel!(options, severity), "SetSessionLogSeverityLevel")
        }
        for o in plan.freeDimensionOverrides {
            try ORTCRuntime.check(
                api, o.name.withCString { api.AddFreeDimensionOverrideByName!(options, $0, o.value) },
                "AddFreeDimensionOverrideByName(\(o.name))"
            )
        }
        switch plan.provider {
        case .cpu:
            break // default CPU EP only: NO SessionOptionsAppendExecutionProvider* call of any kind.
        case .coreML:
            #if canImport(CONNXRuntimeApple)
            // CoreML EP first; ORT keeps the CPU EP registered as fallback for nodes CoreML can't take.
            if let providerOptions = plan.coreMLProviderOptions {
                // Cache: provider-options API (the legacy flags cannot carry ModelCacheDirectory). Same
                // ModelFormat=MLProgram / MLComputeUnits=CPUAndGPU as the flags below.
                try Self.appendExecutionProvider(api: api, options: options, name: "CoreML", providerOptions)
            } else {
                // No cache: unchanged. COREML_FLAG_CREATE_MLPROGRAM (0x010) | COREML_FLAG_USE_CPU_AND_GPU (0x020).
                try ORTCRuntime.check(
                    api, OrtSessionOptionsAppendExecutionProvider_CoreML(
                        options, plan.coreMLLegacyFlags ?? CoreMLModelCache.legacyCoreMLFlags
                    ),
                    "OrtSessionOptionsAppendExecutionProvider_CoreML"
                )
            }
            #else
            throw ORTCError.unsupportedProvider("\(plan.provider)")
            #endif
        }

        var sessionOut: OpaquePointer?
        if let requestedKey = plan.embedCacheKey {
            // Load from bytes with COREML_CACHE_KEY so the CoreML cache key never depends on the path.
            let fileBytes = try Data(contentsOf: modelURL, options: .mappedIfSafe)
            let key = requestedKey ?? CoreMLModelCache.sha256Hex(of: fileBytes)
            let model = CoreMLModelCache.appendingCacheKey(key, toModel: fileBytes)
            self.coreMLCacheKey = key
            let status: OpaquePointer? = model.withUnsafeBytes { raw in
                api.CreateSessionFromArray!(runtime.env, raw.baseAddress, raw.count, options, &sessionOut)
            }
            try ORTCRuntime.check(api, status, "CreateSessionFromArray(\(modelURL.lastPathComponent))")
        } else {
            self.coreMLCacheKey = nil
            try ORTCRuntime.check(
                api,
                modelURL.path.withCString { api.CreateSession!(runtime.env, $0, options, &sessionOut) },
                "CreateSession(\(modelURL.lastPathComponent))"
            )
        }
        guard let sessionOut else { throw ORTCError.ort(code: -1, message: "null OrtSession", call: "CreateSession") }

        var mem: OpaquePointer?
        let memStatus = api.CreateCpuMemoryInfo!(OrtArenaAllocator, OrtMemTypeDefault, &mem)
        if memStatus != nil || mem == nil {
            api.ReleaseSession!(sessionOut)
            try ORTCRuntime.check(api, memStatus, "CreateCpuMemoryInfo")
            throw ORTCError.ort(code: -1, message: "null OrtMemoryInfo", call: "CreateCpuMemoryInfo")
        }

        do {
            let ins = try Self.describe(api: api, session: sessionOut, inputs: true)
            let outs = try Self.describe(api: api, session: sessionOut, inputs: false)
            self.inputInfo = ins
            self.outputInfo = outs
            self.inputNames = ins.map(\.name)
            self.outputNames = outs.map(\.name)
        } catch {
            api.ReleaseMemoryInfo!(mem)
            api.ReleaseSession!(sessionOut)
            throw error
        }
        self.session = sessionOut
        self.memoryInfo = mem!
    }

    /// `SessionOptionsAppendExecutionProvider(options, name, keys, values, n)` (provider-options C API).
    private static func appendExecutionProvider(
        api: OrtApi, options: OpaquePointer?, name: String, _ pairs: [(key: String, value: String)]
    ) throws {
        let keys: [UnsafeMutablePointer<CChar>?] = pairs.map { strdup($0.key) }
        let values: [UnsafeMutablePointer<CChar>?] = pairs.map { strdup($0.value) }
        defer {
            for p in keys { free(p) }
            for p in values { free(p) }
        }
        let status: OpaquePointer? = keys.withUnsafeBufferPointer { k in
            values.withUnsafeBufferPointer { v in
                k.baseAddress!.withMemoryRebound(to: UnsafePointer<CChar>?.self, capacity: k.count) { kp in
                    v.baseAddress!.withMemoryRebound(to: UnsafePointer<CChar>?.self, capacity: v.count) { vp in
                        name.withCString { n in
                            api.SessionOptionsAppendExecutionProvider!(options, n, kp, vp, pairs.count)
                        }
                    }
                }
            }
        }
        try ORTCRuntime.check(api, status, "SessionOptionsAppendExecutionProvider(\(name))")
    }

    /// Custom model metadata value (`metadata_props`), e.g. `COREML_CACHE_KEY` for diagnostics.
    public func modelMetadataValue(forKey key: String) throws -> String? {
        let api = runtime.api
        var metadata: OpaquePointer?
        try ORTCRuntime.check(api, api.SessionGetModelMetadata!(session, &metadata), "SessionGetModelMetadata")
        defer { if let metadata { api.ReleaseModelMetadata!(metadata) } }
        var allocator: UnsafeMutablePointer<OrtAllocator>?
        try ORTCRuntime.check(api, api.GetAllocatorWithDefaultOptions!(&allocator), "GetAllocatorWithDefaultOptions")
        var value: UnsafeMutablePointer<CChar>?
        let status = key.withCString { k in
            api.ModelMetadataLookupCustomMetadataMap!(metadata, allocator, k, &value)
        }
        try ORTCRuntime.check(api, status, "ModelMetadataLookupCustomMetadataMap")
        guard let value else { return nil }
        defer { _ = api.AllocatorFree!(allocator, value) }
        return String(cString: value)
    }

    deinit {
        runtime.api.ReleaseMemoryInfo!(memoryInfo)
        runtime.api.ReleaseSession!(session)
    }

    /// Runs the model. `inputs` must cover every model input. `outputNames` empty = all outputs.
    /// Returns raw output bytes keyed by name (fp16 stays fp16 — no casting here).
    public func run(inputs: [String: ORTTensor], outputNames requested: [String]) throws -> [String: ORTTensor] {
        let api = runtime.api
        let wanted = requested.isEmpty ? outputNames : requested
        for name in wanted where !outputNames.contains(name) { throw ORTCError.unknownName(name) }
        for name in inputs.keys where !inputNames.contains(name) { throw ORTCError.unknownName(name) }

        // Stable order: model input order.
        let ordered: [(String, ORTTensor)] = try inputNames.map { name in
            guard let t = inputs[name] else { throw ORTCError.invalidTensor("missing input '\(name)'") }
            return (name, t)
        }

        var buffers: [UnsafeMutableRawPointer] = []
        var values: [OpaquePointer?] = []
        var cInputNames: [UnsafeMutablePointer<CChar>?] = []
        var cOutputNames: [UnsafeMutablePointer<CChar>?] = wanted.map { strdup($0) }
        var outValues = [OpaquePointer?](repeating: nil, count: wanted.count)
        defer {
            for v in values { if let v { api.ReleaseValue!(v) } }
            for v in outValues { if let v { api.ReleaseValue!(v) } }
            for b in buffers { b.deallocate() }
            for p in cInputNames { free(p) }
            for p in cOutputNames { free(p) }
        }

        for (name, tensor) in ordered {
            let elemSize = Self.byteSize(tensor.type)
            guard tensor.shape.allSatisfy({ $0 >= 0 }) else {
                throw ORTCError.invalidTensor("'\(name)' has negative dim in \(tensor.shape)")
            }
            let count = tensor.shape.reduce(1, *)
            guard tensor.data.count == count * elemSize else {
                throw ORTCError.invalidTensor(
                    "'\(name)' shape \(tensor.shape) \(tensor.type) needs \(count * elemSize) bytes, got \(tensor.data.count)"
                )
            }
            // ORT does not copy user buffers: keep an owned, aligned copy alive until Run returns.
            let byteCount = max(tensor.data.count, 1)
            let buf = UnsafeMutableRawPointer.allocate(byteCount: byteCount, alignment: 16)
            buffers.append(buf)
            tensor.data.withUnsafeBytes { src in
                if let base = src.baseAddress, src.count > 0 { buf.copyMemory(from: base, byteCount: src.count) }
            }
            var dims = tensor.shape.map { Int64($0) }
            var value: OpaquePointer?
            let status = dims.withUnsafeMutableBufferPointer { d in
                api.CreateTensorWithDataAsOrtValue!(
                    memoryInfo, buf, tensor.data.count, d.baseAddress, d.count, Self.onnxType(tensor.type), &value
                )
            }
            try ORTCRuntime.check(api, status, "CreateTensorWithDataAsOrtValue(\(name))")
            values.append(value)
            cInputNames.append(strdup(name))
        }

        let runStatus: OpaquePointer? = cInputNames.withUnsafeBufferPointer { inNamesBuf in
            cOutputNames.withUnsafeMutableBufferPointer { outNamesBuf in
                values.withUnsafeBufferPointer { valuesBuf in
                    outValues.withUnsafeMutableBufferPointer { outBuf in
                        inNamesBuf.baseAddress!.withMemoryRebound(
                            to: UnsafePointer<CChar>?.self, capacity: inNamesBuf.count
                        ) { inNames in
                            outNamesBuf.baseAddress!.withMemoryRebound(
                                to: UnsafePointer<CChar>?.self, capacity: outNamesBuf.count
                            ) { outNames in
                                api.Run!(
                                    session, nil,
                                    inNames, valuesBuf.baseAddress, valuesBuf.count,
                                    outNames, outBuf.count, outBuf.baseAddress
                                )
                            }
                        }
                    }
                }
            }
        }
        try ORTCRuntime.check(api, runStatus, "Run")

        var result: [String: ORTTensor] = [:]
        for (i, name) in wanted.enumerated() {
            guard let value = outValues[i] else { throw ORTCError.invalidTensor("null output '\(name)'") }
            result[name] = try Self.readTensor(api: api, value: value, name: name)
        }
        return result
    }

    // MARK: - Helpers

    /// Bytes per element for `type`.
    public static func byteSize(_ type: ORTElementType) -> Int {
        switch type {
        case .float32, .int32: return 4
        case .float16: return 2
        case .int64: return 8
        }
    }

    private static func onnxType(_ type: ORTElementType) -> ONNXTensorElementDataType {
        switch type {
        case .float32: return ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT
        case .float16: return ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16
        case .int64: return ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64
        case .int32: return ONNX_TENSOR_ELEMENT_DATA_TYPE_INT32
        }
    }

    private static func elementType(_ t: ONNXTensorElementDataType) -> ORTElementType? {
        switch t {
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT: return .float32
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16: return .float16
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64: return .int64
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_INT32: return .int32
        default: return nil
        }
    }

    private static func readTensor(api: OrtApi, value: OpaquePointer, name: String) throws -> ORTTensor {
        var info: OpaquePointer?
        try ORTCRuntime.check(api, api.GetTensorTypeAndShape!(value, &info), "GetTensorTypeAndShape(\(name))")
        defer { if let info { api.ReleaseTensorTypeAndShapeInfo!(info) } }
        var onnx = ONNX_TENSOR_ELEMENT_DATA_TYPE_UNDEFINED
        try ORTCRuntime.check(api, api.GetTensorElementType!(info, &onnx), "GetTensorElementType(\(name))")
        guard let type = elementType(onnx) else {
            throw ORTCError.unsupportedElementType(name: name, onnxType: Int(onnx.rawValue))
        }
        var rank = 0
        try ORTCRuntime.check(api, api.GetDimensionsCount!(info, &rank), "GetDimensionsCount(\(name))")
        var dims = [Int64](repeating: 0, count: rank)
        if rank > 0 {
            try ORTCRuntime.check(api, api.GetDimensions!(info, &dims, rank), "GetDimensions(\(name))")
        }
        let shape = dims.map { Int($0) }
        let byteCount = shape.reduce(1, *) * byteSize(type)
        var raw: UnsafeMutableRawPointer?
        try ORTCRuntime.check(api, api.GetTensorMutableData!(value, &raw), "GetTensorMutableData(\(name))")
        let data: Data
        if byteCount == 0 {
            data = Data()
        } else if let raw {
            data = Data(bytes: raw, count: byteCount)
        } else {
            throw ORTCError.invalidTensor("null data for output '\(name)'")
        }
        return ORTTensor(type: type, shape: shape, data: data)
    }

    private static func describe(api: OrtApi, session: OpaquePointer, inputs: Bool) throws -> [IOInfo] {
        var allocator: UnsafeMutablePointer<OrtAllocator>?
        try ORTCRuntime.check(api, api.GetAllocatorWithDefaultOptions!(&allocator), "GetAllocatorWithDefaultOptions")
        var count = 0
        try ORTCRuntime.check(
            api,
            inputs ? api.SessionGetInputCount!(session, &count) : api.SessionGetOutputCount!(session, &count),
            "SessionGet\(inputs ? "Input" : "Output")Count"
        )
        var result: [IOInfo] = []
        for i in 0..<count {
            var cName: UnsafeMutablePointer<CChar>?
            try ORTCRuntime.check(
                api,
                inputs
                    ? api.SessionGetInputName!(session, i, allocator, &cName)
                    : api.SessionGetOutputName!(session, i, allocator, &cName),
                "SessionGet\(inputs ? "Input" : "Output")Name"
            )
            let name = cName.map { String(cString: $0) } ?? ""
            if let cName { _ = api.AllocatorFree!(allocator, cName) }

            var typeInfo: OpaquePointer?
            try ORTCRuntime.check(
                api,
                inputs
                    ? api.SessionGetInputTypeInfo!(session, i, &typeInfo)
                    : api.SessionGetOutputTypeInfo!(session, i, &typeInfo),
                "SessionGet\(inputs ? "Input" : "Output")TypeInfo(\(name))"
            )
            defer { if let typeInfo { api.ReleaseTypeInfo!(typeInfo) } }
            var tensorInfo: OpaquePointer?
            try ORTCRuntime.check(api, api.CastTypeInfoToTensorInfo!(typeInfo, &tensorInfo), "CastTypeInfoToTensorInfo")
            guard let tensorInfo else {
                // Non-tensor (sequence/map) I/O: report as unsupported type with no shape.
                result.append(IOInfo(name: name, elementType: nil, onnxElementType: 0, shape: [], symbolicShape: []))
                continue
            }
            var onnx = ONNX_TENSOR_ELEMENT_DATA_TYPE_UNDEFINED
            try ORTCRuntime.check(api, api.GetTensorElementType!(tensorInfo, &onnx), "GetTensorElementType")
            var rank = 0
            try ORTCRuntime.check(api, api.GetDimensionsCount!(tensorInfo, &rank), "GetDimensionsCount")
            var dims = [Int64](repeating: 0, count: rank)
            var symbols = [UnsafePointer<CChar>?](repeating: nil, count: rank)
            if rank > 0 {
                try ORTCRuntime.check(api, api.GetDimensions!(tensorInfo, &dims, rank), "GetDimensions")
                try ORTCRuntime.check(api, api.GetSymbolicDimensions!(tensorInfo, &symbols, rank), "GetSymbolicDimensions")
            }
            result.append(
                IOInfo(
                    name: name,
                    elementType: elementType(onnx),
                    onnxElementType: Int(onnx.rawValue),
                    shape: dims.map { Int($0) },
                    symbolicShape: symbols.map { $0.map { String(cString: $0) } ?? "" }
                )
            )
        }
        return result
    }
}
#endif
