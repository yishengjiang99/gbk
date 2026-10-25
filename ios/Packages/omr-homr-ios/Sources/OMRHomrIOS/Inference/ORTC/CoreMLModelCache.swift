// SPDX-License-Identifier: AGPL-3.0-or-later
import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif

/// CoreML EP compiled-model cache (ONNX Runtime `ModelCacheDirectory`), pure helpers shared by
/// `ORTCSession` and tests. Platform-independent: nothing here needs ORT or CoreML.
///
/// Verified against ORT v1.24.2 (what iOS ships; `onnxruntime/core/providers/coreml/`):
/// - `ModelCacheDirectory` is a provider option (`SessionOptionsAppendExecutionProvider("CoreML", …)`);
///   the legacy `OrtSessionOptionsAppendExecutionProvider_CoreML(flags)` cannot set it. ORT itself would
///   cache both model formats (`model_builder.cc` `GetModelOutputPath`: sub-folder suffix `_mlprogram` /
///   `_nn`); this cache path always uses `MLProgram` + `CPUAndGPU`, exactly what the legacy flags
///   `COREML_FLAG_CREATE_MLPROGRAM | COREML_FLAG_USE_CPU_AND_GPU` select, and is used for the ENCODER only.
///   SegNet runs NeuralNetwork via legacy flags 0x000 (MLProgram returns all zeros for its dynamic
///   shapes) and is never cached: create is ~0.1–0.2 s, and that is the configuration verified against
///   the CPU EP (see `SegNetSession.openBackend`).
/// - Layout: `<dir>/<key>/<metadef id>_dynamic_mlprogram/model/…` (+ `compiled_model.mlmodelc`) and
///   `<dir>/<key>/model.txt`. `<key>` = the model's `COREML_CACHE_KEY` metadata if valid, else a
///   MurmurHash3 of the model *file path* (or, for models loaded from bytes, of graph input/output names).
/// - The iOS app bundle path contains a container UUID that changes with every app update, so a
///   path-derived key would miss after every update (≈30 s recompile of the encoder). `ORTCSession`
///   therefore loads a cached CoreML model from bytes with `COREML_CACHE_KEY` appended to the
///   model's `metadata_props` (see `appendingCacheKey(_:toModel:)`); the key never depends on the path.
/// - Key rule (coreml_execution_provider.cc): at most 64 chars, every char `isalnum` (ASCII
///   `[A-Za-z0-9]`); anything else is logged and ignored (path hash used). A lowercase SHA-256 hex
///   digest is exactly 64 alnum chars.
/// - ORT does NOT detect that the ONNX model changed: a stale cache is silently reused. Use one
///   folder per model content (the app: `<AppSupport>/coreml-cache/<sha256>/`) and a content key.
public enum CoreMLModelCache {
    /// ONNX `metadata_props` key the CoreML EP reads (`kCOREML_CACHE_KEY`).
    public static let cacheKeyMetadataName = "COREML_CACHE_KEY"
    /// Longest key ORT accepts.
    public static let maxCacheKeyLength = 64

    /// CoreML EP provider-option names (`coreml_provider_factory.h`, 1.24.2).
    public static let modelFormatOption = "ModelFormat"
    public static let computeUnitsOption = "MLComputeUnits"
    public static let modelCacheDirectoryOption = "ModelCacheDirectory"
    /// Values equal to today's legacy flags (`COREML_FLAG_CREATE_MLPROGRAM | COREML_FLAG_USE_CPU_AND_GPU`).
    public static let modelFormat = "MLProgram"
    public static let computeUnits = "CPUAndGPU"
    /// Legacy flags used when there is NO cache directory (unchanged behaviour): 0x010 | 0x020.
    /// Encoder default. NOT for SegNet (see `SegNetSession.coreMLLegacyFlags`).
    public static let legacyCoreMLFlags: UInt32 = 0x010 | 0x020
    /// `COREML_FLAG_CREATE_MLPROGRAM`; without it the CoreML EP builds a NeuralNetwork model.
    public static let createMLProgramFlag: UInt32 = 0x010

    /// Provider options for `SessionOptionsAppendExecutionProvider(options, "CoreML", keys, values, n)`
    /// with a cache: same format / compute units as the legacy flags, plus `ModelCacheDirectory`.
    public static func providerOptions(cacheDirectory: URL) -> [(key: String, value: String)] {
        [
            (modelFormatOption, modelFormat),
            (computeUnitsOption, computeUnits),
            (modelCacheDirectoryOption, cacheDirectory.path),
        ]
    }

    /// `true` if ORT 1.24.2 accepts `key` as `COREML_CACHE_KEY`: 1…64 ASCII letters / digits.
    public static func isValidCacheKey(_ key: String) -> Bool {
        let bytes = Array(key.utf8)
        guard !bytes.isEmpty, bytes.count <= maxCacheKeyLength else { return false }
        return bytes.allSatisfy { b in
            (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A)
        }
    }

    /// Checks the cache arguments of `ORTCSession` before anything is opened.
    /// - `cacheDirectory` only with `.coreML` (the CPU EP has no compiled-model cache).
    /// - `cacheKey` only together with `cacheDirectory`, and it must pass `isValidCacheKey`.
    /// - `cacheDirectory` must be a file URL.
    public static func validate(provider: ORTProvider, cacheDirectory: URL?, cacheKey: String?) throws {
        guard let cacheDirectory else {
            if cacheKey != nil {
                throw ORTCError.invalidCacheConfiguration("cacheKey is set but cacheDirectory is nil")
            }
            return
        }
        guard case .coreML = provider else {
            throw ORTCError.invalidCacheConfiguration(
                "cacheDirectory is only valid with provider .coreML (CoreML compiled-model cache); got \(provider)"
            )
        }
        guard cacheDirectory.isFileURL, !cacheDirectory.path.isEmpty else {
            throw ORTCError.invalidCacheConfiguration("cacheDirectory must be a file URL; got \(cacheDirectory)")
        }
        if let cacheKey, !isValidCacheKey(cacheKey) {
            throw ORTCError.invalidCacheConfiguration(
                "cacheKey '\(cacheKey)' must be 1...\(maxCacheKeyLength) ASCII letters/digits (ORT COREML_CACHE_KEY rule)"
            )
        }
    }

    /// Serialized ONNX `ModelProto` + one more `metadata_props` entry (`key` → `value`).
    ///
    /// Protobuf allows a message's fields in any order and concatenates repeated fields, so appending
    /// `ModelProto.metadata_props` (field 14, `StringStringEntryProto{key = 1, value = 2}`) to the end of
    /// the file is a valid edit that leaves every other byte untouched. ORT builds its metadata map
    /// in order (`model_metadata_[key] = value`), so an appended entry wins over an earlier one.
    public static func appendingMetadataProp(key: String, value: String, toModel model: Data) -> Data {
        let entry = metadataPropRecord(key: key, value: value)
        var out = Data(capacity: model.count + entry.count)
        out.append(model)
        out.append(contentsOf: entry)
        return out
    }

    /// `appendingMetadataProp(key: "COREML_CACHE_KEY", value: key, toModel:)`.
    public static func appendingCacheKey(_ key: String, toModel model: Data) -> Data {
        appendingMetadataProp(key: cacheKeyMetadataName, value: key, toModel: model)
    }

    /// Wire bytes of one `ModelProto.metadata_props` record: tag 0x72, length, then the entry.
    static func metadataPropRecord(key: String, value: String) -> [UInt8] {
        var entry: [UInt8] = []
        appendLengthDelimited(field: 1, Array(key.utf8), to: &entry)
        appendLengthDelimited(field: 2, Array(value.utf8), to: &entry)
        var record: [UInt8] = []
        appendLengthDelimited(field: 14, entry, to: &record)
        return record
    }

    private static func appendLengthDelimited(field: UInt32, _ payload: [UInt8], to out: inout [UInt8]) {
        appendVarint(UInt64(field << 3 | 2), to: &out)
        appendVarint(UInt64(payload.count), to: &out)
        out.append(contentsOf: payload)
    }

    static func appendVarint(_ value: UInt64, to out: inout [UInt8]) {
        var v = value
        while v >= 0x80 {
            out.append(UInt8(truncatingIfNeeded: v) | 0x80)
            v >>= 7
        }
        out.append(UInt8(v))
    }

    /// Lowercase hex SHA-256 of `data` (CryptoKit on Apple, portable FIPS 180-4 elsewhere).
    public static func sha256Hex(of data: Data) -> String {
        #if canImport(CryptoKit)
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
        #else
        return PortableSHA256.hex(data)
        #endif
    }

    /// Lowercase hex SHA-256 of the file at `url` (== `models.lock` / `shasum -a 256`).
    public static func sha256Hex(ofFileAt url: URL) throws -> String {
        sha256Hex(of: try Data(contentsOf: url, options: .mappedIfSafe))
    }
}

/// Portable SHA-256 (FIPS 180-4), used where CryptoKit is unavailable (Linux). Internal so tests
/// can check it against CryptoKit / known vectors on every platform.
enum PortableSHA256 {
    private static let k: [UInt32] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]

    @inline(__always) private static func rotr(_ x: UInt32, _ n: UInt32) -> UInt32 { (x >> n) | (x << (32 - n)) }

    static func hex(_ data: Data) -> String {
        var h: [UInt32] = [
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
        ]
        var w = [UInt32](repeating: 0, count: 64)
        let fullBlocks = data.count / 64
        data.withUnsafeBytes { raw in
            for block in 0..<fullBlocks {
                compress(UnsafeRawBufferPointer(rebasing: raw[(block * 64)..<(block * 64 + 64)]), &h, &w)
            }
        }
        // Tail + padding (1 or 2 blocks).
        var tail = [UInt8](data.suffix(from: data.startIndex + fullBlocks * 64))
        let bitLen = UInt64(data.count) &* 8
        tail.append(0x80)
        while tail.count % 64 != 56 { tail.append(0) }
        for i in (0..<8).reversed() { tail.append(UInt8(truncatingIfNeeded: bitLen >> (UInt64(i) * 8))) }
        tail.withUnsafeBytes { raw in
            for start in stride(from: 0, to: raw.count, by: 64) {
                compress(UnsafeRawBufferPointer(rebasing: raw[start..<(start + 64)]), &h, &w)
            }
        }
        return h.map { word in
            let s = String(word, radix: 16)
            return String(repeating: "0", count: 8 - s.count) + s
        }.joined()
    }

    private static func compress(_ block: UnsafeRawBufferPointer, _ h: inout [UInt32], _ w: inout [UInt32]) {
        for i in 0..<16 {
            let b0 = UInt32(block[4 * i]) << 24
            let b1 = UInt32(block[4 * i + 1]) << 16
            let b2 = UInt32(block[4 * i + 2]) << 8
            let b3 = UInt32(block[4 * i + 3])
            w[i] = b0 | b1 | b2 | b3
        }
        for i in 16..<64 {
            let s0: UInt32 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3)
            let s1: UInt32 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10)
            let t: UInt32 = w[i - 16] &+ s0
            w[i] = t &+ w[i - 7] &+ s1
        }
        var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7]
        for i in 0..<64 {
            let bigS1: UInt32 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
            let ch: UInt32 = (e & f) ^ (~e & g)
            let t1a: UInt32 = hh &+ bigS1 &+ ch
            let t1: UInt32 = t1a &+ k[i] &+ w[i]
            let bigS0: UInt32 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
            let maj: UInt32 = (a & b) ^ (a & c) ^ (b & c)
            let t2: UInt32 = bigS0 &+ maj
            hh = g; g = f; f = e; e = d &+ t1; d = c; c = b; b = a; a = t1 &+ t2
        }
        h[0] = h[0] &+ a; h[1] = h[1] &+ b; h[2] = h[2] &+ c; h[3] = h[3] &+ d
        h[4] = h[4] &+ e; h[5] = h[5] &+ f; h[6] = h[6] &+ g; h[7] = h[7] &+ hh
    }
}
