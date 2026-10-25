import Foundation

/// Normalized staff tile fed to the encoder: fp32 NCHW `[1, 1, 256, 1280]` after homr's
/// canvas + `ConvertToArray` (`(x/255 - 0.7931) / 0.1738`). Gate-1 input
/// (`fixtures/oracle.c_scale_staff/staff.npy`), so preprocessing stays out of the decode loop.
public struct StaffTensor: Sendable {
    public let values: [Float]
    public let shape: [Int]

    public enum LoadError: Error, Equatable, CustomStringConvertible {
        case badShape([Int])
        case valueCount(expected: Int, got: Int)
        case notNPY(String)
        case unsupportedNPY(String)

        public var description: String {
            switch self {
            case .badShape(let s): return "StaffTensor: shape \(s) != \(StaffInputSpec.nchwShape)"
            case .valueCount(let e, let g): return "StaffTensor: \(g) values, expected \(e)"
            case .notNPY(let m): return "StaffTensor: not a .npy file (\(m))"
            case .unsupportedNPY(let m): return "StaffTensor: unsupported .npy (\(m))"
            }
        }
    }

    /// Validates `shape == [1, 1, 256, 1280]` and `values.count == 327_680`.
    public init(values: [Float], shape: [Int]) throws {
        guard shape == StaffInputSpec.nchwShape else { throw LoadError.badShape(shape) }
        let n = shape.reduce(1, *)
        guard values.count == n else { throw LoadError.valueCount(expected: n, got: values.count) }
        self.values = values
        self.shape = shape
    }

    /// Load a NumPy `.npy` (v1/v2/v3): little-endian `<f4` (`<f2` / `<f8` converted to fp32), C order, shape
    /// `(1, 1, 256, 1280)` — exactly what `np.save` writes for homr's `ConvertToArray` output.
    public static func loadNPY(_ url: URL) throws -> StaffTensor {
        try parseNPY(Data(contentsOf: url))
    }

    /// Little-endian fp32 bytes (what `EncoderSession.generateContext` binds).
    public var float32LEData: Data {
        var d = Data(count: values.count * 4)
        d.withUnsafeMutableBytes { raw in
            let dst = raw.bindMemory(to: UInt32.self)
            for (i, v) in values.enumerated() { dst[i] = v.bitPattern.littleEndian }
        }
        return d
    }

    static func parseNPY(_ d: Data) throws -> StaffTensor {
        let b = [UInt8](d)
        guard b.count > 10, b[0] == 0x93, String(bytes: b[1..<6], encoding: .ascii) == "NUMPY" else {
            throw LoadError.notNPY("missing \\x93NUMPY magic")
        }
        let major = b[6]
        let headerLen: Int
        let start: Int
        switch major {
        case 1:
            headerLen = Int(b[8]) | Int(b[9]) << 8
            start = 10
        case 2, 3:
            guard b.count > 12 else { throw LoadError.notNPY("truncated header") }
            let h0: Int = Int(b[8]) | (Int(b[9]) << 8)
            let h1: Int = (Int(b[10]) << 16) | (Int(b[11]) << 24)
            headerLen = h0 | h1
            start = 12
        default:
            throw LoadError.unsupportedNPY("version \(major)")
        }
        guard b.count >= start + headerLen else { throw LoadError.notNPY("truncated header") }
        // Header is ASCII (v1/v2) or UTF-8 (v3). Decode directly: Foundation's `.isoLatin1`
        // `String(bytes:encoding:)` returns nil on Linux.
        let header = String(decoding: b[start..<(start + headerLen)], as: UTF8.self)
        let compact = header.replacingOccurrences(of: " ", with: "")
        let elemSize: Int
        if compact.contains("'descr':'<f4'") { elemSize = 4 }
        else if compact.contains("'descr':'<f2'") { elemSize = 2 }
        else if compact.contains("'descr':'<f8'") { elemSize = 8 }
        else {
            throw LoadError.unsupportedNPY("need little-endian '<f4', '<f2' or '<f8': \(header)")
        }
        guard compact.contains("'fortran_order':False") else {
            throw LoadError.unsupportedNPY("need C order: \(header)")
        }
        guard let open = compact.range(of: "'shape':("),
              let close = compact[open.upperBound...].firstIndex(of: ")") else {
            throw LoadError.unsupportedNPY("no shape: \(header)")
        }
        let shape = compact[open.upperBound..<close].split(separator: ",").compactMap { Int($0) }
        guard shape == StaffInputSpec.nchwShape else { throw LoadError.badShape(shape) }
        let n = shape.reduce(1, *)
        let bodyStart = start + headerLen
        guard b.count - bodyStart == n * elemSize else {
            throw LoadError.valueCount(expected: n, got: (b.count - bodyStart) / elemSize)
        }
        var values = [Float](repeating: 0, count: n)
        d.withUnsafeBytes { raw in
            switch elemSize {
            case 2: // <f2 → fp32 (exact widening)
                for i in 0..<n {
                    let bits = raw.loadUnaligned(fromByteOffset: bodyStart + i * 2, as: UInt16.self)
                    values[i] = EncoderContext.float32(fromFloat16Bits: UInt16(littleEndian: bits))
                }
            case 8: // <f8 → fp32 (round-to-nearest, == numpy astype(float32))
                for i in 0..<n {
                    let bits = raw.loadUnaligned(fromByteOffset: bodyStart + i * 8, as: UInt64.self)
                    values[i] = Float(Double(bitPattern: UInt64(littleEndian: bits)))
                }
            default:
                for i in 0..<n {
                    let bits = raw.loadUnaligned(fromByteOffset: bodyStart + i * 4, as: UInt32.self)
                    values[i] = Float(bitPattern: UInt32(littleEndian: bits))
                }
            }
        }
        return try StaffTensor(values: values, shape: shape)
    }
}

extension StaffInferenceSession {
    /// Gate-1 entry: bind caller-created ORT backends for the pinned encoder (fp16) and decoder
    /// (fp32). The decoder backend MUST be a CPU session (locked rule): a backend that reports a
    /// non-CPU provider (`ORTProviderReporting`, e.g. `ORTCSession(provider: .coreML)`) is rejected
    /// by `DecoderSession`. Validates model I/O names.
    public convenience init(
        encoder: any ORTSessionBackend,
        decoder: any ORTSessionBackend,
        vocabulary: HomrVocabulary
    ) throws {
        let encoderProvider: EncoderSession.ExecutionProvider =
            (encoder as? any ORTProviderReporting)?.provider == .coreML ? .coreMLFP16 : .cpuFallback
        let enc = try EncoderSession(
            backend: encoder, provider: encoderProvider, inputElementType: .float16
        )
        let dec = try DecoderSession(vocabulary: vocabulary, backend: decoder, provider: .cpu)
        self.init(vocabulary: vocabulary, encoder: enc, decoder: dec)
    }

    /// Staff tensor → encoder (fp16) → `castToFP32ForDecoder()` → decoder loop (fp32 CPU) → raw
    /// decoded symbols (EOS excluded), mirroring homr `Staff2Score.predict`.
    /// Records `lastTiming` (encoder/decoder ms + optional zero-copy metrics).
    public func decodeStaff(tensor: StaffTensor) throws -> [EncodedSymbol] {
        let t0 = ProcessInfo.processInfo.systemUptime
        let context = try encoder.generateContext(staffImageNormalized: tensor.float32LEData)
            .castToFP32ForDecoder()
        let t1 = ProcessInfo.processInfo.systemUptime
        let runner = try decoder.makeStepRunner(context: context)
        let symbols = try decoderLoop.generate(context: context, stepRunner: runner)
        let t2 = ProcessInfo.processInfo.systemUptime
        lastTiming = StaffDecodeTiming(
            encoderMs: (t1 - t0) * 1000,
            decoderMs: (t2 - t1) * 1000,
            bound: runner.boundMetrics
        )
        return symbols
    }
}
