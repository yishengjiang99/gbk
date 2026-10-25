import Foundation

// Backend-neutral ONNX Runtime seam.
//
// Conformers:
// - `ORTCSession` (ORT C API) on Linux (`CONNXRuntime`) AND iOS / macOS (`CONNXRuntimeApple`).
// (The onnxruntime-objc `ORTObjCSession` was removed: the ObjC API cannot bind float16.)
//
// Backends move RAW bytes only (little-endian, row-major, element type as tagged). They never
// convert dtypes: the single fp16 → fp32 cast lives in `EncoderContext.castToFP32ForDecoder()`.
//
// Locked provider rules (enforced by the sessions, not the backend):
// - Encoder / SegNet: `.coreML` (fp16) with CPU fallback on iOS; `.cpu` elsewhere.
// - Decoder: fp32, `.cpu` ONLY on every platform — `DecoderSession` rejects anything else.

public enum ORTElementType: Sendable { case float32, float16, int64, int32 }

public enum ORTProvider: Sendable { case cpu, coreML }

public struct ORTTensor: Sendable {
    public var type: ORTElementType
    public var shape: [Int]
    public var data: Data
    public init(type: ORTElementType, shape: [Int], data: Data) {
        self.type = type
        self.shape = shape
        self.data = data
    }
}

/// Backends that know which execution provider their session was created with. `DecoderSession`
/// uses this to refuse any non-CPU decoder backend.
public protocol ORTProviderReporting {
    var provider: ORTProvider { get }
}

public protocol ORTSessionBackend: AnyObject {
    init(modelURL: URL, provider: ORTProvider) throws
    var inputNames: [String] { get }
    var outputNames: [String] { get }
    func run(inputs: [String: ORTTensor], outputNames: [String]) throws -> [String: ORTTensor]
}

/// Backends that can open a CoreML EP session with a compiled-model cache (`ORTCSession`). Used by
/// `EncoderSession.open(_:fp16ModelURL:fp32ModelURL:cacheDirectory:)`; see
/// `ORTCSession.init(modelURL:provider:cacheDirectory:cacheKey:)` for the cache rules.
public protocol ORTCoreMLCacheableBackend: ORTSessionBackend {
    /// `cacheDirectory` non-nil only with `.coreML`; `cacheKey` nil = backend default (model SHA-256).
    init(modelURL: URL, provider: ORTProvider, cacheDirectory: URL?, cacheKey: String?) throws
}
