#if canImport(CONNXRuntime)
internal import CONNXRuntime
#elseif canImport(CONNXRuntimeApple)
internal import CONNXRuntimeApple
#endif

#if canImport(CONNXRuntime) || canImport(CONNXRuntimeApple)
import Foundation

// MARK: - RAII helpers (OrtValue / OrtIoBinding / buffers / C strings)

/// Owns an `OrtValue*` and releases it on deinit. Not thread-safe.
final class ORTCOwnedValue: @unchecked Sendable {
    let api: OrtApi
    private(set) var value: OpaquePointer?
    /// Buffer passed to `CreateTensorWithDataAsOrtValue` (nil when value was produced by ORT).
    private var ownedBuffer: UnsafeMutableRawPointer?

    init(api: OrtApi, value: OpaquePointer?, ownedBuffer: UnsafeMutableRawPointer? = nil) {
        self.api = api
        self.value = value
        self.ownedBuffer = ownedBuffer
    }

    /// Create a CPU tensor that copies `data` into an aligned owned buffer (empty shape → 0-byte length, 1-byte placeholder).
    static func tensor(
        api: OrtApi, memoryInfo: OpaquePointer, type: ORTElementType, shape: [Int], data: Data
    ) throws -> ORTCOwnedValue {
        let elem = ORTCSession.byteSize(type)
        guard shape.allSatisfy({ $0 >= 0 }) else {
            throw ORTCError.invalidTensor("negative dim in \(shape)")
        }
        let count = shape.reduce(1, *)
        guard data.count == count * elem else {
            throw ORTCError.invalidTensor(
                "shape \(shape) \(type) needs \(count * elem) bytes, got \(data.count)"
            )
        }
        let byteCount = max(data.count, 1)
        let buf = UnsafeMutableRawPointer.allocate(byteCount: byteCount, alignment: 16)
        data.withUnsafeBytes { src in
            if let base = src.baseAddress, src.count > 0 {
                buf.copyMemory(from: base, byteCount: src.count)
            }
        }
        var dims = shape.map { Int64($0) }
        var out: OpaquePointer?
        let status = dims.withUnsafeMutableBufferPointer { d in
            api.CreateTensorWithDataAsOrtValue!(
                memoryInfo, buf, data.count, d.baseAddress, d.count, onnxType(type), &out
            )
        }
        do {
            try ORTCRuntime.check(api, status, "CreateTensorWithDataAsOrtValue")
        } catch {
            buf.deallocate()
            throw error
        }
        guard let out else {
            buf.deallocate()
            throw ORTCError.ort(code: -1, message: "null OrtValue", call: "CreateTensorWithDataAsOrtValue")
        }
        return ORTCOwnedValue(api: api, value: out, ownedBuffer: buf)
    }

    /// Relinquish ownership without releasing (caller becomes responsible).
    func leak() -> OpaquePointer? {
        let v = value
        value = nil
        // Keep ownedBuffer for the lifetime of the OrtValue — transfer both via takeBuffer.
        return v
    }

    func takeBuffer() -> UnsafeMutableRawPointer? {
        let b = ownedBuffer
        ownedBuffer = nil
        return b
    }

    deinit {
        if let value { api.ReleaseValue!(value) }
        if let ownedBuffer { ownedBuffer.deallocate() }
    }

    private static func onnxType(_ type: ORTElementType) -> ONNXTensorElementDataType {
        switch type {
        case .float32: return ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT
        case .float16: return ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16
        case .int64: return ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64
        case .int32: return ONNX_TENSOR_ELEMENT_DATA_TYPE_INT32
        }
    }
}

/// Owns an `OrtIoBinding*` created for one staff decode.
final class ORTCOwnedBinding: @unchecked Sendable {
    let api: OrtApi
    let binding: OpaquePointer

    init(api: OrtApi, session: OpaquePointer) throws {
        self.api = api
        var out: OpaquePointer?
        try ORTCRuntime.check(api, api.CreateIoBinding!(session, &out), "CreateIoBinding")
        guard let out else {
            throw ORTCError.ort(code: -1, message: "null OrtIoBinding", call: "CreateIoBinding")
        }
        self.binding = out
    }

    deinit { api.ReleaseIoBinding!(binding) }

    func clearInputs() { api.ClearBoundInputs!(binding) }
    func clearOutputs() { api.ClearBoundOutputs!(binding) }

    func bindInput(name: UnsafePointer<CChar>, value: OpaquePointer) throws {
        try ORTCRuntime.check(api, api.BindInput!(binding, name, value), "BindInput")
    }

    func bindOutputToDevice(name: UnsafePointer<CChar>, memoryInfo: OpaquePointer) throws {
        try ORTCRuntime.check(
            api, api.BindOutputToDevice!(binding, name, memoryInfo), "BindOutputToDevice"
        )
    }
}

/// `strdup` wrapper freed on deinit.
final class ORTCOwnedCString: @unchecked Sendable {
    let ptr: UnsafeMutablePointer<CChar>
    init(_ s: String) throws {
        guard let p = strdup(s) else { throw ORTCError.invalidTensor("strdup(\(s)) failed") }
        ptr = p
    }
    deinit { free(ptr) }
}

// MARK: - Zero-copy decoder step runner (IoBinding)

/// Per-staff ORT I/O Binding decoder: keeps KV-cache as resident `OrtValue`s and rebinds
/// `cache_out*` → `cache_in*` with no Swift `Data` materialization of the caches.
///
/// Mirrors `homr/transformer/decoder_inference.py` `ScoreDecoder.generate` IoBinding loop.
/// One instance per staff decode (not shared across concurrent staffs).
public final class ORTBoundDecoderRunner: @unchecked Sendable {
    public struct Metrics: Sendable, Equatable {
        public var totalDecoderMs: Double = 0
        public var ortInferenceMs: Double = 0
        public var bindingSetupMs: Double = 0
        public var argmaxMs: Double = 0
        public var tokenCount: Int = 0
        /// Bytes of KV-cache that passed through Swift `Data` (must stay 0 after init empty caches).
        public var cacheBytesCopiedThroughSwift: Int = 0
        public var nativeCacheRebinds: Int = 0
        public var perTokenMs: [Double] = []

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

    private let ort: ORTCSession
    private let api: OrtApi
    private let binding: ORTCOwnedBinding
    private let headNames: [ORTCOwnedCString]
    private let cacheInNames: [ORTCOwnedCString]
    private let cacheOutNames: [ORTCOwnedCString]
    private let tokenNames: [ORTCOwnedCString]  // rhythms…slurs, context, cache_len
    private let fullContext: ORTCOwnedValue
    private let reducedContext: ORTCOwnedValue
    /// Current KV cache as native OrtValues (length = 32). Released only after next generation is acquired.
    private var cache: [ORTCOwnedValue]
    private let emptyCache: [ORTCOwnedValue]
    private let kvCount: Int
    public private(set) var metrics = Metrics()

    init(ort: ORTCSession, context: EncoderContext, session: DecoderSession) throws {
        guard context.dtype == .float32 else {
            throw OMRError.sessionNotConfigured(
                "ORTBoundDecoderRunner requires fp32 context; got \(context.dtype.rawValue)"
            )
        }
        let s = context.shape
        guard s.count == 3, s[0] == 1, s[1] >= 1, s[2] == session.decoderDim,
              context.bytes.count == s.reduce(1, *) * 4 else {
            throw OMRError.sessionNotConfigured(
                "Decoder context shape \(s) / \(context.bytes.count) bytes is not fp32 [1, seq, \(session.decoderDim)]"
            )
        }
        self.ort = ort
        self.api = ort.runtime.api
        self.kvCount = session.kvCacheTensorCount
        self.binding = try ORTCOwnedBinding(api: api, session: ort.session)

        self.headNames = try DecoderSession.outputNames.map { try ORTCOwnedCString($0) }
        self.cacheInNames = try (0..<kvCount).map { try ORTCOwnedCString("cache_in\($0)") }
        self.cacheOutNames = try (0..<kvCount).map { try ORTCOwnedCString("cache_out\($0)") }
        self.tokenNames = try (DecoderSession.inputNames).map { try ORTCOwnedCString($0) }

        self.fullContext = try ORTCOwnedValue.tensor(
            api: api, memoryInfo: ort.memoryInfo, type: .float32, shape: s, data: context.bytes
        )
        let reducedBytes = context.bytes.prefix(s[2] * 4)
        self.reducedContext = try ORTCOwnedValue.tensor(
            api: api, memoryInfo: ort.memoryInfo, type: .float32, shape: [1, 1, s[2]],
            data: Data(reducedBytes)
        )

        // Empty KV: [1, 8, 0, 64] fp32 — 0 bytes each. Counted once at init (not per step).
        var empty: [ORTCOwnedValue] = []
        empty.reserveCapacity(kvCount)
        let emptyShape = [1, session.decoderHeads, 0, session.headDim]
        for _ in 0..<kvCount {
            empty.append(try ORTCOwnedValue.tensor(
                api: api, memoryInfo: ort.memoryInfo, type: .float32, shape: emptyShape, data: Data()
            ))
        }
        self.emptyCache = empty
        self.cache = empty
        // Initial empty caches are tiny (0 payload); do not count as "copied through Swift" per step.
        metrics.cacheBytesCopiedThroughSwift = 0
    }

    func runStep(_ input: DecoderStepInput) throws -> DecoderStepOutput {
        let tStep0 = ProcessInfo.processInfo.systemUptime
        if input.cacheLen == 0 {
            // Reset to empty caches without releasing the retained empty set.
            // Previous generation (if any) from a prior decode on this runner is released first.
            if !cacheElementsEqual(cache, emptyCache) {
                cache = emptyCache
            }
        }

        let tBind0 = ProcessInfo.processInfo.systemUptime
        binding.clearInputs()
        binding.clearOutputs()

        // Token / scalar inputs (small; Swift Data → OrtValue is fine).
        let rhythm = try int64Tensor([Int64(input.rhythm)], shape: [1, 1])
        let pitch = try int64Tensor([Int64(input.pitch)], shape: [1, 1])
        let lift = try int64Tensor([Int64(input.lift)], shape: [1, 1])
        let artic = try int64Tensor([Int64(input.articulation)], shape: [1, 1])
        let slur = try int64Tensor([Int64(input.slur)], shape: [1, 1])
        let cacheLen = try int64Tensor([Int64(input.cacheLen)], shape: [1])
        let ctx = input.useFullContext ? fullContext : reducedContext

        // tokenNames: rhythms, pitchs, lifts, articulations, slurs, context, cache_len
        try binding.bindInput(name: tokenNames[0].ptr, value: rhythm.value!)
        try binding.bindInput(name: tokenNames[1].ptr, value: pitch.value!)
        try binding.bindInput(name: tokenNames[2].ptr, value: lift.value!)
        try binding.bindInput(name: tokenNames[3].ptr, value: artic.value!)
        try binding.bindInput(name: tokenNames[4].ptr, value: slur.value!)
        try binding.bindInput(name: tokenNames[5].ptr, value: ctx.value!)
        try binding.bindInput(name: tokenNames[6].ptr, value: cacheLen.value!)

        for i in 0..<kvCount {
            guard let v = cache[i].value else {
                throw ORTCError.invalidTensor("null cache_in\(i)")
            }
            try binding.bindInput(name: cacheInNames[i].ptr, value: v)
        }
        if input.cacheLen > 0 {
            metrics.nativeCacheRebinds += kvCount
        }

        // Heads + caches: allocate on CPU device (no pre-sized Swift buffers).
        for n in headNames {
            try binding.bindOutputToDevice(name: n.ptr, memoryInfo: ort.memoryInfo)
        }
        for n in cacheOutNames {
            try binding.bindOutputToDevice(name: n.ptr, memoryInfo: ort.memoryInfo)
        }
        let tBind1 = ProcessInfo.processInfo.systemUptime
        metrics.bindingSetupMs += (tBind1 - tBind0) * 1000

        let tOrt0 = ProcessInfo.processInfo.systemUptime
        try ORTCRuntime.check(
            api, api.RunWithBinding!(ort.session, nil, binding.binding), "RunWithBinding"
        )
        let tOrt1 = ProcessInfo.processInfo.systemUptime
        metrics.ortInferenceMs += (tOrt1 - tOrt0) * 1000

        // Transfer output OrtValues to Swift ownership.
        var allocator: UnsafeMutablePointer<OrtAllocator>?
        try ORTCRuntime.check(
            api, api.GetAllocatorWithDefaultOptions!(&allocator), "GetAllocatorWithDefaultOptions"
        )
        // OrtValue*** → we receive an allocator-owned array of OrtValue*.
        var outArray: UnsafeMutablePointer<OpaquePointer?>? = nil
        var outCount: Int = 0
        try ORTCRuntime.check(
            api,
            api.GetBoundOutputValues!(
                binding.binding, allocator,
                &outArray, &outCount
            ),
            "GetBoundOutputValues"
        )
        guard let outArray, outCount == headNames.count + kvCount else {
            throw ORTCError.invalidTensor(
                "GetBoundOutputValues expected \(headNames.count + kvCount), got \(outCount)"
            )
        }
        defer {
            // Free the pointer array after each OrtValue has been wrapped (or released).
            _ = api.AllocatorFree!(allocator, outArray)
        }

        // Heads 0..<7: temporary ownership for argmax / attention copy, then release.
        let tArg0 = ProcessInfo.processInfo.systemUptime
        let headOwned: [ORTCOwnedValue] = try (0..<7).map { i in
            guard let v = outArray[i] else {
                throw ORTCError.invalidTensor("null bound output \(i)")
            }
            return ORTCOwnedValue(api: api, value: v)
        }
        let rhythmA = try argmaxLastRow(headOwned[0], name: "out_rhythms")
        let pitchA = try argmaxLastRow(headOwned[1], name: "out_pitchs")
        let liftA = try argmaxLastRow(headOwned[2], name: "out_lifts")
        let posA = try argmaxLastRow(headOwned[3], name: "out_positions")
        let articA = try argmaxLastRow(headOwned[4], name: "out_articulations")
        let slurA = try argmaxLastRow(headOwned[5], name: "out_slurs")
        let attentionBlob = try copyTensorBytes(headOwned[6], name: "attention")
        let tArg1 = ProcessInfo.processInfo.systemUptime
        metrics.argmaxMs += (tArg1 - tArg0) * 1000
        _ = headOwned  // release head OrtValues now

        // cache_out* → next cache_in* (exclusive ownership; release previous only after acquire).
        var nextCache: [ORTCOwnedValue] = []
        nextCache.reserveCapacity(kvCount)
        for i in 0..<kvCount {
            guard let v = outArray[7 + i] else {
                throw ORTCError.invalidTensor("null cache_out\(i)")
            }
            nextCache.append(ORTCOwnedValue(api: api, value: v))
        }
        let previous = cache
        cache = nextCache
        _ = previous

        // Token input OrtValues released here (end of scope): rhythm, pitch, …
        _ = (rhythm, pitch, lift, artic, slur, cacheLen)

        metrics.tokenCount += 1
        let tStep1 = ProcessInfo.processInfo.systemUptime
        let stepMs = (tStep1 - tStep0) * 1000
        metrics.perTokenMs.append(stepMs)
        metrics.totalDecoderMs += stepMs

        return DecoderStepOutput(
            rhythmArgmax: rhythmA,
            pitchArgmax: pitchA,
            liftArgmax: liftA,
            positionArgmax: posA,
            articulationArgmax: articA,
            slurArgmax: slurA,
            attentionBlob: attentionBlob
        )
    }

    private func cacheElementsEqual(_ a: [ORTCOwnedValue], _ b: [ORTCOwnedValue]) -> Bool {
        a.count == b.count && zip(a, b).allSatisfy { $0.value == $1.value }
    }

    private func int64Tensor(_ values: [Int64], shape: [Int]) throws -> ORTCOwnedValue {
        var d = Data(capacity: values.count * 8)
        for v in values {
            withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) }
        }
        return try ORTCOwnedValue.tensor(
            api: api, memoryInfo: ort.memoryInfo, type: .int64, shape: shape, data: d
        )
    }

    /// NumPy `x[:, -1, :].argmax()` on a float32 tensor OrtValue (first max; first NaN wins).
    private func argmaxLastRow(_ owned: ORTCOwnedValue, name: String) throws -> Int {
        guard let value = owned.value else {
            throw ORTCError.invalidTensor("null \(name)")
        }
        var info: OpaquePointer?
        try ORTCRuntime.check(api, api.GetTensorTypeAndShape!(value, &info), "GetTensorTypeAndShape(\(name))")
        defer { if let info { api.ReleaseTensorTypeAndShapeInfo!(info) } }
        var onnx = ONNX_TENSOR_ELEMENT_DATA_TYPE_UNDEFINED
        try ORTCRuntime.check(api, api.GetTensorElementType!(info, &onnx), "GetTensorElementType(\(name))")
        guard onnx == ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT else {
            throw ORTCError.invalidTensor("\(name): expected float32 logits")
        }
        var rank = 0
        try ORTCRuntime.check(api, api.GetDimensionsCount!(info, &rank), "GetDimensionsCount(\(name))")
        var dims = [Int64](repeating: 0, count: rank)
        if rank > 0 {
            try ORTCRuntime.check(api, api.GetDimensions!(info, &dims, rank), "GetDimensions(\(name))")
        }
        let shape = dims.map { Int($0) }
        guard let v = shape.last, v > 0 else {
            throw ORTCError.invalidTensor("\(name): empty last dim \(shape)")
        }
        let total = shape.reduce(1, *)
        guard total >= v else {
            throw ORTCError.invalidTensor("\(name): shape \(shape)")
        }
        var raw: UnsafeMutableRawPointer?
        try ORTCRuntime.check(api, api.GetTensorMutableData!(value, &raw), "GetTensorMutableData(\(name))")
        guard let raw else {
            throw ORTCError.invalidTensor("null data for \(name)")
        }
        let start = (total - v) * 4
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

    private func copyTensorBytes(_ owned: ORTCOwnedValue, name: String) throws -> Data {
        guard let value = owned.value else {
            throw ORTCError.invalidTensor("null \(name)")
        }
        var info: OpaquePointer?
        try ORTCRuntime.check(api, api.GetTensorTypeAndShape!(value, &info), "GetTensorTypeAndShape(\(name))")
        defer { if let info { api.ReleaseTensorTypeAndShapeInfo!(info) } }
        var onnx = ONNX_TENSOR_ELEMENT_DATA_TYPE_UNDEFINED
        try ORTCRuntime.check(api, api.GetTensorElementType!(info, &onnx), "GetTensorElementType(\(name))")
        let elem: Int
        switch onnx {
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT: elem = 4
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16: elem = 2
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64: elem = 8
        case ONNX_TENSOR_ELEMENT_DATA_TYPE_INT32: elem = 4
        default:
            throw ORTCError.unsupportedElementType(name: name, onnxType: Int(onnx.rawValue))
        }
        var rank = 0
        try ORTCRuntime.check(api, api.GetDimensionsCount!(info, &rank), "GetDimensionsCount(\(name))")
        var dims = [Int64](repeating: 0, count: rank)
        if rank > 0 {
            try ORTCRuntime.check(api, api.GetDimensions!(info, &dims, rank), "GetDimensions(\(name))")
        }
        let byteCount = dims.map { Int($0) }.reduce(1, *) * elem
        var raw: UnsafeMutableRawPointer?
        try ORTCRuntime.check(api, api.GetTensorMutableData!(value, &raw), "GetTensorMutableData(\(name))")
        if byteCount == 0 { return Data() }
        guard let raw else { throw ORTCError.invalidTensor("null data for \(name)") }
        return Data(bytes: raw, count: byteCount)
    }
}

#endif
