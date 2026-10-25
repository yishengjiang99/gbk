// SPDX-License-Identifier: AGPL-3.0-or-later
// Vendored unchanged from yishengjiang99/earsheet @ 357cb76 Packages/HearSheet (Copyright (C) 2026 Yisheng Jiang).
import CoreML
import Foundation

/// Loads the BasicPitch_nmp-contract Core ML package and runs window inference.
///
/// Contract (see models.lock): input `input_2` [1, 43844, 1] float32 at
/// 22050 Hz mono; outputs note [1, 172, 88] (`Identity_1`), onset
/// [1, 172, 88] (`Identity_2`), contour [1, 172, 264] (`Identity`).
/// The graph is never modified here; a Phase-B checkpoint with the same
/// contract loads through this same path.
public final class BasicPitchModel {
    public enum LoadError: Error, CustomStringConvertible {
        case missingPackage(URL)
        case missingFeature(String)
        case predictionFailed(Error)
        public var description: String {
            switch self {
            case .missingPackage(let u): return "BasicPitchPoly.mlpackage not found at \(u.path) (run scripts/fetch-models)"
            case .missingFeature(let n): return "Core ML model has no output feature '\(n)'"
            case .predictionFailed(let e): return "Core ML prediction failed: \(e)"
            }
        }
    }

    private let model: MLModel
    private let lock = NSLock()
    /// Decoder thresholds that belong to this model, read at load time from the
    /// package's sidecar (`BasicPitchPoly.thresholds.json` next to the package);
    /// `BasicPitchDecoder.Thresholds.basicPitchDefaults` when there is none.
    public let thresholds: BasicPitchDecoder.Thresholds
    /// Whether `thresholds` came from a sidecar (false = documented defaults).
    public let thresholdsFromSidecar: Bool
    private let featureNames: (note: String, onset: String, contour: String)

    /// - Parameter modelsDirectory: directory containing `BasicPitchPoly.mlpackage`
    ///   (the app bundle's `models/` or `TEST_RUNNER_OMR_MODELS_DIR`-style override).
    public init(modelsDirectory: URL) throws {
        let packageURL = modelsDirectory.appendingPathComponent("BasicPitchPoly.mlpackage", isDirectory: true)
        guard FileManager.default.fileExists(atPath: packageURL.path) else {
            throw LoadError.missingPackage(packageURL)
        }
        let compiledURL = try Self.persistentCompiledURL(for: packageURL)
        if !FileManager.default.fileExists(atPath: compiledURL.path) {
            let tmp = try MLModel.compileModel(at: packageURL)
            try FileManager.default.createDirectory(
                at: compiledURL.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: compiledURL.path) {
                try FileManager.default.removeItem(at: compiledURL)
            }
            try FileManager.default.moveItem(at: tmp, to: compiledURL)
        }
        let config = MLModelConfiguration()
        config.computeUnits = .all
        let m = try MLModel(contentsOf: compiledURL, configuration: config)
        self.model = m
        self.featureNames = try Self.resolveFeatureNames(model: m)
        let loaded = BasicPitchDecoder.Thresholds.load(forPackageAt: packageURL)
        self.thresholds = loaded.thresholds
        self.thresholdsFromSidecar = loaded.fromSidecar
    }

    public struct Posteriorgrams {
        /// [172][88]
        public var note: [[Float]]
        /// [172][88]
        public var onset: [[Float]]
        /// [172][264]
        public var contour: [[Float]]
    }

    /// Runs one 43844-sample window. Serialized internally; call off the main thread.
    public func predict(waveform: [Float]) throws -> Posteriorgrams {
        precondition(waveform.count == HearSheet.windowSamples)
        lock.lock()
        defer { lock.unlock() }
        do {
            let input = try MLMultiArray(shape: [1, 43844, 1] as [NSNumber], dataType: .float32)
            let dst = input.dataPointer.bindMemory(to: Float.self, capacity: HearSheet.windowSamples)
            waveform.withUnsafeBufferPointer { src in
                dst.update(from: src.baseAddress!, count: HearSheet.windowSamples)
            }
            let provider = try MLDictionaryFeatureProvider(
                dictionary: ["input_2": MLFeatureValue(multiArray: input)])
            let out = try model.prediction(from: provider)
            return Posteriorgrams(
                note: try read2D(out, name: featureNames.note, d1: 172, d2: 88),
                onset: try read2D(out, name: featureNames.onset, d1: 172, d2: 88),
                contour: try read2D(out, name: featureNames.contour, d1: 172, d2: 264)
            )
        } catch let e as LoadError {
            throw e
        } catch {
            throw LoadError.predictionFailed(error)
        }
    }

    // MARK: - Private

    private func read2D(_ out: MLFeatureProvider, name: String, d1: Int, d2: Int) throws -> [[Float]] {
        guard let ma = out.featureValue(for: name)?.multiArrayValue,
              ma.shape.count == 3,
              ma.shape[0].intValue == 1, ma.shape[1].intValue == d1, ma.shape[2].intValue == d2,
              ma.dataType == .float32
        else { throw LoadError.missingFeature(name) }
        let strides = ma.strides.map(\.intValue) // elements
        // Core ML binds the buffer to dataType already; assume, don't re-bind.
        let ptr = ma.dataPointer.assumingMemoryBound(to: Float.self)
        var rows: [[Float]] = []
        rows.reserveCapacity(d1)
        for i in 0..<d1 {
            var row = [Float](repeating: 0, count: d2)
            let base = i * strides[1]
            for j in 0..<d2 { row[j] = ptr[base + j * strides[2]] }
            rows.append(row)
        }
        return rows
    }

    /// Maps output features by the BasicPitch_nmp contract names, so a
    /// re-exported checkpoint with the same contract keeps working.
    private static func resolveFeatureNames(model: MLModel) throws -> (note: String, onset: String, contour: String) {
        let outs = model.modelDescription.outputDescriptionsByName
        func pick(_ candidates: [String]) -> String? {
            candidates.first { outs[$0] != nil }
        }
        guard let note = pick(["Identity_1", "note"]),
              let onset = pick(["Identity_2", "onset"]),
              let contour = pick(["Identity", "contour"])
        else {
            throw LoadError.missingFeature("Identity_1/Identity_2/Identity (note/onset/contour)")
        }
        return (note, onset, contour)
    }

    /// Persistent compiled-model cache, keyed by the complete source package so
    /// a swapped checkpoint recompiles instead of loading a stale cache.
    private static func persistentCompiledURL(for packageURL: URL) throws -> URL {
        let support = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true)
        let key = try cacheKey(forPackageAt: packageURL)
        return support
            .appendingPathComponent("EarSheet", isDirectory: true)
            .appendingPathComponent("BasicPitchPoly-\(key).mlmodelc", isDirectory: true)
    }

    /// FNV-1a over every regular file in the package (relative path + bytes, sorted by path),
    /// including `weights/weight.bin`. The thresholds sidecar lives outside the package, so
    /// changing thresholds never forces a recompile.
    static func cacheKey(forPackageAt packageURL: URL) throws -> String {
        let rootPath = packageURL.standardizedFileURL.path
        let enumerator = FileManager.default.enumerator(
            at: packageURL, includingPropertiesForKeys: [.isRegularFileKey])
        var files: [URL] = []
        while let url = enumerator?.nextObject() as? URL {
            if try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true {
                files.append(url)
            }
        }
        files.sort { $0.path < $1.path }

        var h: UInt64 = 0xcbf29ce484222325
        func update(_ bytes: some Sequence<UInt8>) {
            for b in bytes {
                h ^= UInt64(b)
                h = h &* 0x100000001b3
            }
        }
        for url in files {
            let relativePath = String(url.standardizedFileURL.path.dropFirst(rootPath.count + 1))
            update(relativePath.utf8)
            update([0])
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
                update(chunk)
            }
        }
        return String(format: "%016llx", h)
    }
}

// MARK: - Shared loader

/// Lazily loads and shares one BasicPitchModel across transcriptions.
/// Thread-safe; safe to capture in a detached task.
public final class ModelBox: Sendable {
    /// The app-wide loader. All call sites share one cached model;
    /// do not create additional instances.
    public static let shared = ModelBox()

    private let inner = LockedModelBox()

    private init() {}

    /// Returns the cached model for `modelsDirectory`, loading it on first use.
    /// Call off the main thread: the first call compiles the Core ML package.
    public func get(modelsDirectory: URL) throws -> BasicPitchModel {
        try inner.get(modelsDirectory: modelsDirectory)
    }
}

private final class LockedModelBox: @unchecked Sendable {
    private let lock = NSLock()
    private var directory: URL?
    private var model: BasicPitchModel?

    func get(modelsDirectory: URL) throws -> BasicPitchModel {
        lock.lock()
        defer { lock.unlock() }
        if let m = model, directory == modelsDirectory { return m }
        let m = try BasicPitchModel(modelsDirectory: modelsDirectory)
        directory = modelsDirectory
        model = m
        return m
    }
}
