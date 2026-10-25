import Foundation

/// Encoder (staff → context) session over a backend-neutral `ORTSessionBackend`.
///
/// Product rule: Encoder runs the **fp16** checkpoint on the **CoreML EP** with CPU fallback on
/// Apple platforms; elsewhere (Linux host tools) it runs on the CPU EP. Never GPU for the decoder.
///
/// Mirrors `homr/transformer/encoder_inference.py` `Encoder.generate`:
/// ```
/// io_binding.bind_cpu_input("input", x.astype(np.float16 if fp16 else np.float32))
/// io_binding.bind_output("output", ...)
/// ```
/// Pinned model (models.lock): `encoder_pytorch_model_465-…_fp16.onnx`
/// - input  `input`  float16 `[1, 1, 256, 1280]` (NCHW, `StaffInputSpec` normalized)
/// - output `output` float16 `[1, 1280, 512]`
///
/// The context comes back in the model's dtype; the ONE fp16 → fp32 cast for the decoder is
/// `EncoderContext.castToFP32ForDecoder()`. (The fp32 → fp16 cast of the *input image* below
/// is upstream's `x.astype(np.float16)`, not a context cast.)
public final class EncoderSession: @unchecked Sendable {
    public enum ExecutionProvider: String, Sendable {
        case coreMLFP16 = "CoreML-fp16"
        case cpuFallback = "CPU-fallback"
    }

    /// ONNX input / output names (upstream binds these literally).
    public static let inputName = "input"
    public static let outputName = "output"
    /// Encoder output shape for the pinned checkpoint: `[1, 1280, 512]`.
    public static let contextShape = [1, 1280, 512]

    public let preferredProvider: ExecutionProvider
    public private(set) var activeProvider: ExecutionProvider?
    public private(set) var isConfigured: Bool

    /// Model path once weights are fetched (`scripts/fetch-models` → repo-root `models/`).
    public let modelURL: URL?

    /// Bound ORT backend (nil in the scaffold / before `open`).
    public private(set) var backend: (any ORTSessionBackend)?
    /// Element type the bound model expects for `input` (`.float16` for the pinned checkpoint).
    public private(set) var inputElementType: ORTElementType = .float16

    /// Scaffold initializer (no backend). `configureStub()` / `generateContext` throw until a
    /// backend is bound via `init(backend:…)` or `open(_:fp16ModelURL:fp32ModelURL:)`.
    public init(modelURL: URL? = nil, preferredProvider: ExecutionProvider = .coreMLFP16) {
        self.modelURL = modelURL
        self.preferredProvider = preferredProvider
        self.activeProvider = nil
        self.isConfigured = false
    }

    /// Bind an already-created backend. Validates the model exposes `input` / `output`.
    public init(
        backend: any ORTSessionBackend,
        provider: ExecutionProvider,
        inputElementType: ORTElementType = .float16,
        modelURL: URL? = nil
    ) throws {
        guard inputElementType == .float16 || inputElementType == .float32 else {
            throw OMRError.sessionNotConfigured(
                "Encoder input must be float16 or float32; got \(inputElementType)"
            )
        }
        guard backend.inputNames.contains(Self.inputName) else {
            throw OMRError.sessionNotConfigured(
                "Encoder model has no '\(Self.inputName)' input (inputs: \(backend.inputNames))"
            )
        }
        guard backend.outputNames.contains(Self.outputName) else {
            throw OMRError.sessionNotConfigured(
                "Encoder model has no '\(Self.outputName)' output (outputs: \(backend.outputNames))"
            )
        }
        self.modelURL = modelURL
        self.preferredProvider = provider
        self.activeProvider = provider
        self.isConfigured = true
        self.backend = backend
        self.inputElementType = inputElementType
    }

    /// Open the encoder with the locked EP policy.
    ///
    /// - Apple (CoreML available): try `fp16ModelURL` on `.coreML` (ORT keeps CPU as the
    ///   fallback EP for nodes CoreML cannot take). If creating that session throws, fall back
    ///   to a `.cpu` session on `fp32ModelURL ?? fp16ModelURL`.
    /// - Other platforms: `.cpu` session on `fp32ModelURL ?? fp16ModelURL`.
    ///
    /// The input dtype follows the model file: fp16 checkpoint → `.float16`, fp32 → `.float32`.
    ///
    /// - Parameter cacheDirectory: CoreML compiled-model cache folder for the fp16 encoder (the app's
    ///   `<AppSupport>/coreml-cache/<sha256>/`); nil (default) = no cache. Used only for the `.coreML`
    ///   attempt (never for the CPU fallback) and ignored where CoreML is unavailable (Linux). Requires a
    ///   backend conforming to `ORTCoreMLCacheableBackend` (`ORTCSession`), else throws. Cache key =
    ///   `cacheKey` ?? SHA-256 of the model file. See `ORTCSession.init(modelURL:provider:cacheDirectory:cacheKey:)`.
    public static func open<B: ORTSessionBackend>(
        _ backendType: B.Type,
        fp16ModelURL: URL?,
        fp32ModelURL: URL? = nil,
        cacheDirectory: URL? = nil,
        cacheKey: String? = nil
    ) throws -> EncoderSession {
        if cacheDirectory != nil, !(B.self is any ORTCoreMLCacheableBackend.Type) {
            throw OMRError.sessionNotConfigured(
                "EncoderSession.open: cacheDirectory needs an ORTCoreMLCacheableBackend (ORTCSession); got \(B.self)"
            )
        }
        var coreMLError: Error?
        #if canImport(CoreML)
        if let fp16 = fp16ModelURL {
            do {
                let b = try makeCoreMLBackend(B.self, modelURL: fp16, cacheDirectory: cacheDirectory, cacheKey: cacheKey)
                return try EncoderSession(
                    backend: b, provider: .coreMLFP16, inputElementType: .float16, modelURL: fp16
                )
            } catch {
                coreMLError = error
            }
        }
        #endif
        guard let cpuURL = fp32ModelURL ?? fp16ModelURL else {
            throw OMRError.modelsNotBundled(
                "Encoder ONNX not found. Run scripts/fetch-models (pinned in models.lock)."
                    + (coreMLError.map { " CoreML error: \($0)" } ?? "")
            )
        }
        let b = try B(modelURL: cpuURL, provider: .cpu)
        return try EncoderSession(
            backend: b,
            provider: .cpuFallback,
            inputElementType: fp32ModelURL != nil ? .float32 : .float16,
            modelURL: cpuURL
        )
    }

    /// `.coreML` backend, with the compiled-model cache when `cacheDirectory` is set.
    static func makeCoreMLBackend<B: ORTSessionBackend>(
        _ backendType: B.Type, modelURL: URL, cacheDirectory: URL?, cacheKey: String?
    ) throws -> B {
        guard let cacheDirectory else { return try B(modelURL: modelURL, provider: .coreML) }
        guard let cacheable = B.self as? any ORTCoreMLCacheableBackend.Type else {
            throw OMRError.sessionNotConfigured("\(B.self) does not support a CoreML cache directory")
        }
        let made = try cacheable.init(
            modelURL: modelURL, provider: .coreML, cacheDirectory: cacheDirectory, cacheKey: cacheKey
        )
        guard let b = made as? B else {
            throw OMRError.sessionNotConfigured("\(type(of: made)) is not \(B.self)")
        }
        return b
    }

    /// Kept for app warm-up: succeeds when a backend is bound, else throws the scaffold error.
    public func configureStub() throws {
        if backend != nil { return }
        guard let modelURL else {
            throw OMRError.modelsNotBundled(
                "Encoder fp16 ONNX not bundled. Run scripts/fetch-models (liebharc/homr onnx_checkpoints)."
            )
        }
        _ = modelURL
        throw OMRError.sessionNotConfigured(
            "No ORTSessionBackend bound; use EncoderSession.open(_:fp16ModelURL:) with ORTCSession (ORT C API; Linux and Apple)"
        )
    }

    /// Staff image → encoder context (dtype = model output dtype, fp16 for the pinned model).
    ///
    /// - Parameter staffImageNormalized: little-endian **fp32** NCHW `[1,1,256,1280]` bytes after
    ///   `StaffInputSpec` normalize (upstream `ConvertToArray` returns float32).
    public func generateContext(staffImageNormalized: Data) throws -> EncoderContext {
        guard let backend else {
            throw OMRError.sessionNotConfigured(
                "EncoderSession.generateContext: no ORTSessionBackend bound; expected staff NCHW \(StaffInputSpec.nchwShape)"
            )
        }
        let shape = StaffInputSpec.nchwShape
        let count = shape.reduce(1, *)
        guard staffImageNormalized.count == count * 4 else {
            throw OMRError.sessionNotConfigured(
                "Encoder input must be \(count) fp32 values (\(count * 4) bytes) for \(shape); got \(staffImageNormalized.count) bytes"
            )
        }
        let inputData: Data
        switch inputElementType {
        case .float16: inputData = Self.float16Data(fromFloat32LE: staffImageNormalized)
        default: inputData = staffImageNormalized
        }
        let out = try backend.run(
            inputs: [Self.inputName: ORTTensor(type: inputElementType, shape: shape, data: inputData)],
            outputNames: [Self.outputName]
        )
        guard let ctx = out[Self.outputName] else {
            throw OMRError.sessionNotConfigured("Encoder run returned no '\(Self.outputName)'")
        }
        let dtype: EncoderContext.ContextDType
        let elem: Int
        switch ctx.type {
        case .float16: dtype = .float16; elem = 2
        case .float32: dtype = .float32; elem = 4
        default:
            throw OMRError.sessionNotConfigured("Encoder output dtype \(ctx.type) is not float16/float32")
        }
        guard ctx.shape.count == 3, ctx.shape[0] == 1,
              ctx.data.count == ctx.shape.reduce(1, *) * elem else {
            throw OMRError.sessionNotConfigured(
                "Encoder output shape \(ctx.shape) / \(ctx.data.count) bytes is not [1, seq, dim]"
            )
        }
        return EncoderContext(bytes: ctx.data, dtype: dtype, shape: ctx.shape)
    }

    /// fp32 LE → fp16 LE (round-to-nearest-even), == NumPy `astype(np.float16)`.
    static func float16Data(fromFloat32LE data: Data) -> Data {
        let n = data.count / 4
        var out = Data(count: n * 2)
        data.withUnsafeBytes { src in
            out.withUnsafeMutableBytes { dst in
                let d = dst.bindMemory(to: UInt16.self)
                for i in 0..<n {
                    let bits = src.loadUnaligned(fromByteOffset: i * 4, as: UInt32.self)
                    d[i] = float16Bits(fromFloat32Bits: UInt32(littleEndian: bits)).littleEndian
                }
            }
        }
        return out
    }

    /// IEEE754 binary32 bits → binary16 bits, round-to-nearest-even, overflow → ±inf.
    static func float16Bits(fromFloat32Bits x: UInt32) -> UInt16 {
        let sign = UInt16((x >> 16) & 0x8000)
        let exp = Int((x >> 23) & 0xFF)
        let mant = x & 0x7F_FFFF
        if exp == 0xFF { // inf / nan
            return sign | 0x7C00 | (mant != 0 ? UInt16(0x200 | (mant >> 13)) : 0)
        }
        let e = exp - 127 + 15
        if e >= 0x1F { return sign | 0x7C00 }
        if e <= 0 {
            if e < -10 { return sign } // underflow → ±0
            let m = mant | 0x80_0000 // implicit 1
            let shift = UInt32(14 - e)
            var half = m >> shift
            let rem = m & ((1 << shift) - 1)
            let halfway = UInt32(1) << (shift - 1)
            if rem > halfway || (rem == halfway && (half & 1) == 1) { half += 1 }
            return sign | UInt16(half)
        }
        var half = UInt32(e) << 10 | (mant >> 13)
        let rem = mant & 0x1FFF
        if rem > 0x1000 || (rem == 0x1000 && (half & 1) == 1) { half += 1 } // may carry into exp: ok
        return sign | UInt16(half)
    }
}

/// Opaque encoder context handed to the decoder after fp16→fp32 cast when needed.
///
/// Mirrors `staff2score.py`:
/// ```
/// context = encoder.generate(x)
/// context_dtype = float16 if decoder.fp16 else float32
/// if context.dtype != context_dtype: context = context.astype(context_dtype)
/// ```
/// Locked product path: Decoder is fp32 CPU → always cast fp16→fp32 here.
public struct EncoderContext: Sendable {
    public var bytes: Data
    public var dtype: ContextDType
    /// Logical shape e.g. `[1, seq, dim]` — filled when ORT binding lands.
    public var shape: [Int]

    public enum ContextDType: String, Sendable {
        case float16
        case float32
    }

    public init(bytes: Data, dtype: ContextDType, shape: [Int]) {
        self.bytes = bytes
        self.dtype = dtype
        self.shape = shape
    }

    /// Product rule: cast context fp16→fp32 before Decoder ORT CPU.
    ///
    /// When `bytes` hold IEEE754 binary16 little-endian values, widens each
    /// element to binary32. Empty / already-fp32 contexts pass through.
    public func castToFP32ForDecoder() -> EncoderContext {
        guard dtype == .float16 else { return self }
        guard !bytes.isEmpty else {
            return EncoderContext(bytes: bytes, dtype: .float32, shape: shape)
        }
        guard bytes.count % 2 == 0 else {
            // Malformed half buffer — keep dtype marker honest; ORT bind will fail loudly later.
            return EncoderContext(bytes: bytes, dtype: .float32, shape: shape)
        }
        // Single preallocated fp32 buffer — no intermediate [Float] then second Data copy.
        let halfCount = bytes.count / 2
        var outData = Data(count: halfCount * MemoryLayout<Float>.size)
        bytes.withUnsafeBytes { srcRaw in
            outData.withUnsafeMutableBytes { dstRaw in
                let src = srcRaw.bindMemory(to: UInt16.self)
                let dst = dstRaw.bindMemory(to: Float.self)
                for i in 0..<halfCount {
                    dst[i] = Self.float32(fromFloat16Bits: src[i])
                }
            }
        }
        return EncoderContext(bytes: outData, dtype: .float32, shape: shape)
    }

    /// IEEE754 binary16 → Float (matches NumPy `astype(float32)` for finite values).
    static func float32(fromFloat16Bits bits: UInt16) -> Float {
        let sign = UInt32((bits & 0x8000) >> 15)
        let exp = Int((bits & 0x7C00) >> 10)
        let frac = UInt32(bits & 0x03FF)

        let sign32 = sign << 31
        if exp == 0 {
            if frac == 0 {
                return Float(bitPattern: sign32)
            }
            // Subnormal half → normalized float
            var f = frac
            var e = -14 + 127
            while f & 0x0400 == 0 {
                f <<= 1
                e -= 1
            }
            f &= 0x03FF
            let bits32 = sign32 | (UInt32(e) << 23) | (f << 13)
            return Float(bitPattern: bits32)
        }
        if exp == 0x1F {
            // Inf / NaN
            let bits32 = sign32 | 0x7F800000 | (frac << 13)
            return Float(bitPattern: bits32)
        }
        let exp32 = UInt32(exp - 15 + 127)
        let bits32 = sign32 | (exp32 << 23) | (frac << 13)
        return Float(bitPattern: bits32)
    }
}
