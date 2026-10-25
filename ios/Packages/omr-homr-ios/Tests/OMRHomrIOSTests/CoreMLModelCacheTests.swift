// SPDX-License-Identifier: AGPL-3.0-or-later
import XCTest
@testable import OMRHomrIOS

/// CoreML compiled-model cache (`ORTCSession(modelURL:provider:cacheDirectory:cacheKey:)`): argument rules,
/// provider-option construction, the `COREML_CACHE_KEY` protobuf append, SHA-256 keys, and (where ORT is
/// linked) that ORT really reads the embedded key. The CoreML part itself runs only on Apple
/// (`testAppleCoreMLCacheIsKeyedByContentNotPath`).
final class CoreMLModelCacheTests: XCTestCase {
    static let segnetName = "segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f_fp16.onnx"
    static let segnetSHA256 = "60f495496cb41473c0521d0811d8f44b9d5cff892d287974a8aebb3eaee2fa83" // models.lock
    static let encoderName = "encoder_pytorch_model_465-597144cab54c8f6d0f6c9619df5c5312694eadd6_fp16.onnx"

    static func modelsDir() throws -> URL {
        if let env = ProcessInfo.processInfo.environment["OMR_MODELS_DIR"], !env.isEmpty {
            return URL(fileURLWithPath: env, isDirectory: true)
        }
        return try WriterOnlyFixtureTests.fixturesRoot().deletingLastPathComponent().appendingPathComponent("models")
    }

    static func model(_ name: String) throws -> URL {
        let url = try modelsDir().appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { throw XCTSkip("run scripts/fetch-models") }
        return url
    }

    // MARK: - Argument rules

    func testCacheDirectoryWithCPUThrows() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("coreml-cache-cpu")
        XCTAssertThrowsError(try CoreMLModelCache.validate(provider: .cpu, cacheDirectory: dir, cacheKey: nil)) { error in
            guard case ORTCError.invalidCacheConfiguration = error else { return XCTFail("got \(error)") }
        }
        #if canImport(CONNXRuntime) || canImport(CONNXRuntimeApple)
        // Rejected before the (nonexistent) model is touched, on every platform.
        let missing = URL(fileURLWithPath: "/nonexistent/model.onnx")
        XCTAssertThrowsError(try ORTCSession(modelURL: missing, provider: .cpu, cacheDirectory: dir)) { error in
            guard case ORTCError.invalidCacheConfiguration = error else { return XCTFail("got \(error)") }
        }
        XCTAssertThrowsError(
            try ORTCSession(modelURL: missing, provider: .cpu, intraOpThreads: 1, cacheDirectory: dir, cacheKey: "abc")
        ) { error in
            guard case ORTCError.invalidCacheConfiguration = error else { return XCTFail("got \(error)") }
        }
        #endif
    }

    func testCacheKeyRules() throws {
        let dir = URL(fileURLWithPath: "/tmp/coreml-cache/x", isDirectory: true)
        // Key without a directory is meaningless.
        XCTAssertThrowsError(try CoreMLModelCache.validate(provider: .coreML, cacheDirectory: nil, cacheKey: "abc"))
        // No cache at all: fine for both providers.
        XCTAssertNoThrow(try CoreMLModelCache.validate(provider: .cpu, cacheDirectory: nil, cacheKey: nil))
        XCTAssertNoThrow(try CoreMLModelCache.validate(provider: .coreML, cacheDirectory: nil, cacheKey: nil))
        XCTAssertNoThrow(try CoreMLModelCache.validate(provider: .coreML, cacheDirectory: dir, cacheKey: nil))
        XCTAssertNoThrow(try CoreMLModelCache.validate(provider: .coreML, cacheDirectory: dir, cacheKey: Self.segnetSHA256))
        // Non-file URL.
        XCTAssertThrowsError(
            try CoreMLModelCache.validate(provider: .coreML, cacheDirectory: URL(string: "https://x/y")!, cacheKey: nil)
        )
        // ORT 1.24.2 rule: <= 64 chars, all isalnum.
        XCTAssertTrue(CoreMLModelCache.isValidCacheKey(Self.segnetSHA256))
        XCTAssertEqual(Self.segnetSHA256.count, CoreMLModelCache.maxCacheKeyLength)
        XCTAssertTrue(CoreMLModelCache.isValidCacheKey("ABCxyz0189"))
        XCTAssertFalse(CoreMLModelCache.isValidCacheKey(""))
        XCTAssertFalse(CoreMLModelCache.isValidCacheKey(String(repeating: "a", count: 65)))
        XCTAssertFalse(CoreMLModelCache.isValidCacheKey("abc_def")) // "_" would also break ORT's key split
        XCTAssertFalse(CoreMLModelCache.isValidCacheKey("abc-def"))
        XCTAssertFalse(CoreMLModelCache.isValidCacheKey("abc/def"))
        XCTAssertFalse(CoreMLModelCache.isValidCacheKey("caf\u{E9}"))
        XCTAssertThrowsError(try CoreMLModelCache.validate(provider: .coreML, cacheDirectory: dir, cacheKey: "a b"))
    }

    // MARK: - Provider options

    func testProviderOptionsKeepFormatAndComputeUnitsAndAddCacheDirectory() {
        let dir = URL(fileURLWithPath: "/var/mobile/AppSupport/coreml-cache/\(Self.segnetSHA256)", isDirectory: true)
        let opts = CoreMLModelCache.providerOptions(cacheDirectory: dir)
        XCTAssertEqual(opts.map(\.key), ["ModelFormat", "MLComputeUnits", "ModelCacheDirectory"])
        XCTAssertEqual(opts.map(\.value), ["MLProgram", "CPUAndGPU", dir.path])
        // The no-cache path keeps the legacy flags: COREML_FLAG_CREATE_MLPROGRAM | COREML_FLAG_USE_CPU_AND_GPU.
        XCTAssertEqual(CoreMLModelCache.legacyCoreMLFlags, 0x030)
    }

    // MARK: - COREML_CACHE_KEY protobuf append

    func testMetadataPropRecordWireBytes() {
        // Same bytes as a Python varint/protobuf encoder (and accepted by onnxruntime 1.30 Python).
        let rec = CoreMLModelCache.metadataPropRecord(key: "COREML_CACHE_KEY", value: "ab")
        XCTAssertEqual(rec.map { String(format: "%02x", $0) }.joined(), "72160a10434f52454d4c5f43414348455f4b455912026162")
        // Multi-byte varint lengths.
        var v: [UInt8] = []
        CoreMLModelCache.appendVarint(300, to: &v)
        XCTAssertEqual(v, [0xAC, 0x02])
        let long = CoreMLModelCache.metadataPropRecord(key: "k", value: String(repeating: "x", count: 200))
        XCTAssertEqual(Array(long.prefix(3)), [0x72, 0xCE, 0x01]) // entry = 3 + 3 + 200 = 206 bytes
    }

    func testAppendingCacheKeyLeavesModelBytesUntouched() {
        let model = Data((0..<1000).map { UInt8(truncatingIfNeeded: $0 &* 7) })
        let tagged = CoreMLModelCache.appendingCacheKey("abc", toModel: model)
        XCTAssertEqual(tagged.prefix(model.count), model)
        XCTAssertEqual(Array(tagged.suffix(from: model.count)), CoreMLModelCache.metadataPropRecord(key: "COREML_CACHE_KEY", value: "abc"))
        // Works on a Data slice (non-zero startIndex).
        let slice = model[10..<500]
        XCTAssertEqual(CoreMLModelCache.appendingCacheKey("abc", toModel: slice).prefix(490), Data(slice))
    }

    // MARK: - SHA-256

    func testSHA256KnownVectors() throws {
        let vectors: [(String, String)] = [
            ("", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
            ("abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
            ("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
             "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"),
        ]
        for (msg, want) in vectors {
            XCTAssertEqual(CoreMLModelCache.sha256Hex(of: Data(msg.utf8)), want, msg)
            XCTAssertEqual(PortableSHA256.hex(Data(msg.utf8)), want, msg)
        }
        // Portable == platform (CryptoKit on Apple) on odd sizes around the block boundary, and on a slice.
        for n in [55, 56, 63, 64, 65, 119, 120, 1000, 4097] {
            let d = Data((0..<n).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ 7) })
            XCTAssertEqual(PortableSHA256.hex(d), CoreMLModelCache.sha256Hex(of: d), "n=\(n)")
            XCTAssertEqual(PortableSHA256.hex(d[3...]), CoreMLModelCache.sha256Hex(of: Data(d[3...])), "slice n=\(n)")
        }
        // File helper.
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("sha-\(UUID().uuidString).bin")
        try Data("abc".utf8).write(to: tmp)
        defer { try? FileManager.default.removeItem(at: tmp) }
        XCTAssertEqual(try CoreMLModelCache.sha256Hex(ofFileAt: tmp), vectors[1].1)
    }

    func testDefaultKeyIsModelsLockSHA256() throws {
        // The default cacheKey is the model file's SHA-256 == the models.lock entry (a valid ORT key).
        let seg = try Self.model(Self.segnetName)
        let key = try CoreMLModelCache.sha256Hex(ofFileAt: seg)
        XCTAssertEqual(key, Self.segnetSHA256)
        XCTAssertTrue(CoreMLModelCache.isValidCacheKey(key))
    }

    // MARK: - ORT reads the embedded key (CPU EP; any platform with ORT)

    func testEmbeddedCacheKeyIsReadByORT() throws {
        #if canImport(CONNXRuntime) || canImport(CONNXRuntimeApple)
        let seg = try Self.model(Self.segnetName)
        let byPath = try ORTCSession(modelURL: seg, provider: .cpu)
        XCTAssertNil(try byPath.modelMetadataValue(forKey: CoreMLModelCache.cacheKeyMetadataName))
        XCTAssertNil(byPath.coreMLCacheKey)
        XCTAssertNil(byPath.coreMLCacheDirectory)

        // Same loading path the CoreML cache uses (bytes + appended COREML_CACHE_KEY), on the CPU EP.
        var plan = ORTCSession.SessionPlan(provider: .cpu, intraOpThreads: 1)
        plan.embedCacheKey = .some("abc123XYZ")
        let tagged = try ORTCSession(modelURL: seg, plan: plan)
        XCTAssertEqual(try tagged.modelMetadataValue(forKey: CoreMLModelCache.cacheKeyMetadataName), "abc123XYZ")
        XCTAssertEqual(tagged.coreMLCacheKey, "abc123XYZ")
        XCTAssertEqual(tagged.inputNames, byPath.inputNames)
        XCTAssertEqual(tagged.outputNames, byPath.outputNames)
        XCTAssertEqual(tagged.inputInfo.map(\.description), byPath.inputInfo.map(\.description))
        #else
        throw XCTSkip("ORT not linked")
        #endif
    }

    // MARK: - Decoder / encoder policy

    func testDecoderStillRejectsNonCPUBackend() throws {
        let vocab = try TokenizerLoader.loadVocabulary()
        let url = URL(fileURLWithPath: "/m/decoder.onnx")
        let coreML = try ORTProviderPolicyTests.ReportingDecoderBackend(modelURL: url, provider: .coreML)
        XCTAssertThrowsError(try DecoderSession(vocabulary: vocab, backend: coreML, provider: .cpu))
        XCTAssertThrowsError(try DecoderSession(vocabulary: vocab, backend: coreML, provider: .coreML))
        let cpu = try ORTProviderPolicyTests.ReportingDecoderBackend(modelURL: url, provider: .cpu)
        XCTAssertThrowsError(try DecoderSession(vocabulary: vocab, backend: cpu, provider: .coreML))
    }

    func testEncoderOpenWithCacheNeedsCacheableBackend() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("coreml-cache-enc")
        XCTAssertThrowsError(
            try EncoderSession.open(
                ORTProviderPolicyTests.ReportingDecoderBackend.self,
                fp16ModelURL: URL(fileURLWithPath: "/m/encoder_fp16.onnx"),
                cacheDirectory: dir
            )
        )
    }

    func testEncoderOpenWithCacheFallsBackToPlainCPUOnLinux() throws {
        #if canImport(CONNXRuntime) && os(Linux)
        let enc = try Self.model(Self.encoderName)
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("coreml-cache-\(UUID().uuidString)")
        let s = try EncoderSession.open(ORTCSession.self, fp16ModelURL: enc, cacheDirectory: dir)
        XCTAssertEqual(s.activeProvider, .cpuFallback)
        XCTAssertEqual((s.backend as? ORTCSession)?.provider, .cpu)
        XCTAssertNil((s.backend as? ORTCSession)?.coreMLCacheDirectory)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.path)) // package never creates the folder
        #else
        throw XCTSkip("Linux-only (CPU fallback path)")
        #endif
    }

    // MARK: - Real CoreML EP cache (Apple only)

    /// SegNet on the CoreML EP with a cache: key = models.lock SHA-256 (embedded, read back by ORT), ORT
    /// writes `<dir>/<key>/…/compiled_model.mlmodelc`, and a copy of the model at ANOTHER path (what an iOS
    /// app update does to the bundle path) reuses the same entry instead of creating a new one.
    func testAppleCoreMLCacheIsKeyedByContentNotPath() throws {
        #if canImport(CONNXRuntimeApple)
        let seg = try Self.model(Self.segnetName)
        let fm = FileManager.default
        let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("omr-coreml-\(UUID().uuidString)")
        let cache = root.appendingPathComponent("coreml-cache/\(Self.segnetSHA256)", isDirectory: true)
        defer { try? fm.removeItem(at: root) }

        func timed<T>(_ f: () throws -> T) rethrows -> (T, Double) {
            let t = Date()
            let v = try f()
            return (v, Date().timeIntervalSince(t) * 1000)
        }
        let (plain, plainMs) = try timed { try ORTCSession(modelURL: seg, provider: .coreML) }
        XCTAssertNil(plain.coreMLCacheKey)

        let (first, firstMs) = try timed { try ORTCSession(modelURL: seg, provider: .coreML, cacheDirectory: cache) }
        XCTAssertEqual(first.provider, .coreML)
        XCTAssertEqual(first.coreMLCacheKey, Self.segnetSHA256)
        XCTAssertEqual(try first.modelMetadataValue(forKey: "COREML_CACHE_KEY"), Self.segnetSHA256)
        XCTAssertEqual(first.inputNames, plain.inputNames)
        let entries = try fm.contentsOfDirectory(atPath: cache.path)
        XCTAssertEqual(entries, [Self.segnetSHA256], "ORT cache entry must be named by the key, not a path hash")
        let entry = cache.appendingPathComponent(Self.segnetSHA256)
        let files = (fm.enumerator(atPath: entry.path)?.allObjects as? [String]) ?? []
        XCTAssertTrue(files.contains { $0.hasSuffix("compiled_model.mlmodelc") }, "no compiled model in \(files.prefix(20))")

        // Same bytes at a different path (new container UUID after an app update).
        let moved = root.appendingPathComponent("Bundle-\(UUID().uuidString)/models/\(Self.segnetName)")
        try fm.createDirectory(at: moved.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fm.copyItem(at: seg, to: moved)
        let (second, secondMs) = try timed {
            try ORTCSession(modelURL: moved, provider: .coreML, cacheDirectory: cache, cacheKey: Self.segnetSHA256)
        }
        XCTAssertEqual(second.coreMLCacheKey, Self.segnetSHA256)
        XCTAssertEqual(try fm.contentsOfDirectory(atPath: cache.path), [Self.segnetSHA256], "cache miss: new entry created")
        print(String(format: "[coreml-cache] segnet create: no cache %.0f ms, cache cold %.0f ms, cache warm (moved path) %.0f ms",
                     plainMs, firstMs, secondMs))
        #else
        throw XCTSkip("CoreML EP is Apple-only")
        #endif
    }
}
