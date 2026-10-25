// SPDX-License-Identifier: AGPL-3.0-or-later
import XCTest
@testable import OMRHomrIOS

/// SegNet on the CoreML EP vs the CPU EP (OMR iOS saw every pixel = class 0 on the iOS simulator).
/// Diagnostic, not a gate: prints one `[segnet-diag]` line per configuration (raw output stats on one
/// C-scale tile + full-page class counts vs CPU). Needs ORT + models; the CoreML rows run on Apple only.
/// Skipped unless `OMR_SEGNET_DIAG=1` or `OMR_SEGNET_DIAG_VERBOSE=1` (manual `coreml-diag.yml` sets them;
/// on the simulator via `TEST_RUNNER_…`): 16 CoreML session creates take minutes, normal CI stays fast.
/// Result that fixed SegNet (run 36275275275): NeuralNetwork 0x000 = CPU EP exactly; MLProgram = all zeros.
final class SegNetCoreMLDiagTests: XCTestCase {
    static var enabled: Bool {
        let env = ProcessInfo.processInfo.environment
        return env["OMR_SEGNET_DIAG"] == "1" || env["OMR_SEGNET_DIAG_VERBOSE"] == "1"
    }

    /// Always on (cheap, no ORT session): the SegNet plan is NeuralNetwork 0x000 with no cache in any form.
    func testSegNetSessionPlanIsNeuralNetworkWithoutCache() {
        #if canImport(CONNXRuntime) || canImport(CONNXRuntimeApple)
        XCTAssertEqual(SegNetSession.coreMLLegacyFlags, 0x000)
        let plan = SegNetSession.sessionPlan(provider: .coreML, intraOpThreads: 1)
        XCTAssertEqual(plan.coreMLLegacyFlags, 0x000)
        XCTAssertEqual(plan.coreMLModelFormat, "NeuralNetwork")
        XCTAssertNil(plan.coreMLProviderOptions, "provider options would bypass the legacy flags")
        XCTAssertNil(plan.cacheDirectory)
        XCTAssertTrue(plan.embedCacheKey == nil, "SegNet is opened by path (no COREML_CACHE_KEY)")
        XCTAssertTrue(plan.freeDimensionOverrides.isEmpty)
        let cpu = SegNetSession.sessionPlan(provider: .cpu, intraOpThreads: 1)
        XCTAssertNil(cpu.coreMLLegacyFlags)
        XCTAssertNil(cpu.coreMLModelFormat)
        // Encoder default stays MLProgram (Gate 1 12/12 with 0x030).
        XCTAssertEqual(ORTCSession.SessionPlan(provider: .coreML, intraOpThreads: 1).coreMLModelFormat, "MLProgram")
        #endif
    }

    /// `segnetCacheDirectory` / `cacheDirectory` for SegNet is a silent no-op: no throw, nothing created.
    func testSegNetCacheDirectoryIsIgnored() throws {
        #if canImport(CONNXRuntime) || canImport(CONNXRuntimeApple)
        let model = try CoreMLModelCacheTests.model(CoreMLModelCacheTests.segnetName)
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("segnet-nocache-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let cpu = try SegNetSession.openBackend(modelURL: model, provider: .cpu, cacheDirectory: dir)
        XCTAssertEqual(cpu.provider, .cpu)
        XCTAssertNil(cpu.coreMLCacheDirectory)
        XCTAssertNil(cpu.coreMLCacheKey)
        #if canImport(CONNXRuntimeApple)
        let t0 = Date()
        let ml = try SegNetSession.openBackend(modelURL: model, provider: .coreML, cacheDirectory: dir)
        print(String(format: "[segnet-diag] SegNetSession.openBackend(.coreML) create %.0f ms, format %@",
                     Date().timeIntervalSince(t0) * 1000, ml.coreMLModelFormat ?? "nil"))
        XCTAssertEqual(ml.provider, .coreML)
        XCTAssertEqual(ml.coreMLModelFormat, "NeuralNetwork")
        XCTAssertNil(ml.coreMLCacheDirectory)
        XCTAssertNil(ml.coreMLCacheKey)
        #endif
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.path), "SegNet must not touch the cache folder")
        #else
        throw XCTSkip("ORT not linked")
        #endif
    }

    struct Stats: CustomStringConvertible {
        var type: ORTElementType
        var shape: [Int]
        var min = Float.infinity, max = -Float.infinity, sum = 0.0
        var nan = 0, inf = 0, count = 0
        var argmax = [Int](repeating: 0, count: SegNetSession.classCount)
        var description: String {
            String(format: "%@ %@ min %.3f max %.3f mean %.4f nan %d inf %d argmax %@",
                   "\(type)", "\(shape)", min, max, sum / Double(Swift.max(count, 1)), nan, inf, "\(argmax)")
        }
    }

    static func values(_ t: ORTTensor) -> [Float] {
        t.data.withUnsafeBytes { raw -> [Float] in
            switch t.type {
            case .float16:
                return raw.bindMemory(to: UInt16.self).map { EncoderContext.float32(fromFloat16Bits: UInt16(littleEndian: $0)) }
            case .float32:
                return raw.bindMemory(to: UInt32.self).map { Float(bitPattern: UInt32(littleEndian: $0)) }
            default:
                return []
            }
        }
    }

    /// Stats of batch element 0 of an NCHW `[n, 6, 320, 320]` output; argmax like SegNetSession (first max).
    static func stats(_ t: ORTTensor) -> (Stats, [Float]) {
        let v = values(t)
        var s = Stats(type: t.type, shape: t.shape)
        for x in v {
            if x.isNaN { s.nan += 1; continue }
            if x.isInfinite { s.inf += 1; continue }
            s.min = Swift.min(s.min, x); s.max = Swift.max(s.max, x); s.sum += Double(x); s.count += 1
        }
        let plane = SegNetSession.windowSize * SegNetSession.windowSize
        if v.count >= SegNetSession.classCount * plane {
            for i in 0..<plane {
                var best = v[i], bi = 0
                if !best.isNaN {
                    for c in 1..<SegNetSession.classCount {
                        let x = v[c * plane + i]
                        if x.isNaN { bi = c; break }
                        if x > best { best = x; bi = c }
                    }
                }
                s.argmax[bi] += 1
            }
        }
        return (s, Array(v.prefix(SegNetSession.classCount * plane)))
    }

    static func tileInput(_ page: [UInt8], width w: Int, y: Int, x: Int, batch: Int) -> ORTTensor {
        let win = SegNetSession.windowSize, plane = win * win
        var d = Data(count: batch * 3 * plane * 2)
        d.withUnsafeMutableBytes { raw in
            let dst = raw.bindMemory(to: UInt16.self)
            for b in 0..<batch {
                for py in 0..<win {
                    for px in 0..<win {
                        let h = SegNetSession.halfOfByte[Int(page[(y + py) * w + x + px])]
                        for c in 0..<3 { dst[b * 3 * plane + c * plane + py * win + px] = h.littleEndian }
                    }
                }
            }
        }
        return ORTTensor(type: .float16, shape: [batch, 3, win, win], data: d)
    }

    func testSegNetCoreMLVsCPU() throws {
        guard Self.enabled else {
            throw XCTSkip("SegNet CoreML diag: set OMR_SEGNET_DIAG=1 (coreml-diag.yml) to run all variants")
        }
        #if canImport(CONNXRuntime) || canImport(CONNXRuntimeApple)
        let model = try CoreMLModelCacheTests.model(CoreMLModelCacheTests.segnetName)
        let pngURL = try WriterOnlyFixtureTests.fixturesRoot()
            .appendingPathComponent("oracle.pages/mono.c_major_scale/preprocessed.png")
        let g = try PagePipeline.decodeGrayPNG(Data(contentsOf: pngURL))
        let (page, w, h) = (g.pixels, g.width, g.height)
        // Tile with the most ink among the aligned 320x320 tiles.
        var best = (dark: -1, y: 0, x: 0)
        for y in stride(from: 0, through: h - 320, by: 320) {
            for x in stride(from: 0, through: w - 320, by: 320) {
                var dark = 0
                for py in 0..<320 { for px in 0..<320 where page[(y + py) * w + x + px] < 128 { dark += 1 } }
                if dark > best.dark { best = (dark, y, x) }
            }
        }
        print("[segnet-diag] page \(w)x\(h), tile y=\(best.y) x=\(best.x) (\(best.dark) dark px), ORT \(ORTCSession.runtimeVersion)")

        struct Variant { var name: String; var plan: ORTCSession.SessionPlan; var batch: Int? }
        func plan(_ p: ORTProvider, flags: UInt32? = nil, options: [(key: String, value: String)]? = nil,
                  batch: Int64? = nil, verbose: Bool = false) -> ORTCSession.SessionPlan {
            var pl = ORTCSession.SessionPlan(provider: p, intraOpThreads: 1)
            pl.coreMLLegacyFlags = flags
            pl.coreMLProviderOptions = options
            if let batch { pl.freeDimensionOverrides = [("batch_size", batch)] }
            if verbose { pl.logSeverity = 0 }
            return pl
        }
        func opts(_ format: String, _ units: String, static isStatic: Bool = false) -> [(key: String, value: String)] {
            var o: [(key: String, value: String)] = [("ModelFormat", format), ("MLComputeUnits", units)]
            if isStatic { o.append(("RequireStaticInputShapes", "1")) }
            return o
        }
        let cpuVariant = [Variant(name: "CPU EP", plan: plan(.cpu), batch: nil)]
        #if canImport(CONNXRuntimeApple)
        let cacheDir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("segnet-diag-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: cacheDir) }
        var cached = plan(.coreML, options: CoreMLModelCache.providerOptions(cacheDirectory: cacheDir))
        cached.cacheDirectory = cacheDir
        cached.embedCacheKey = .some(CoreMLModelCacheTests.segnetSHA256)
        let diagVerbose = ProcessInfo.processInfo.environment["OMR_SEGNET_DIAG_VERBOSE"] == "1"
        let variants = cpuVariant + [
            Variant(name: "SegNetSession.openBackend (shipping: legacy 0x000 NeuralNetwork ALL)",
                    plan: SegNetSession.sessionPlan(provider: .coreML, intraOpThreads: 1), batch: nil),
            Variant(name: "legacy 0x030 MLProgram CPUAndGPU (app default)", plan: plan(.coreML, verbose: diagVerbose), batch: nil),
            Variant(name: "legacy 0x010 MLProgram ALL", plan: plan(.coreML, flags: 0x010), batch: nil),
            Variant(name: "legacy 0x011 MLProgram CPUOnly", plan: plan(.coreML, flags: 0x011), batch: nil),
            Variant(name: "legacy 0x000 NeuralNetwork ALL", plan: plan(.coreML, flags: 0x000), batch: nil),
            Variant(name: "legacy 0x020 NeuralNetwork CPUAndGPU", plan: plan(.coreML, flags: 0x020), batch: nil),
            Variant(name: "legacy 0x001 NeuralNetwork CPUOnly", plan: plan(.coreML, flags: 0x001), batch: nil),
            Variant(name: "legacy 0x038 MLProgram CPUAndGPU static-only", plan: plan(.coreML, flags: 0x038), batch: nil),
            Variant(name: "opts MLProgram CPUOnly", plan: plan(.coreML, options: opts("MLProgram", "CPUOnly")), batch: nil),
            Variant(name: "opts MLProgram ALL", plan: plan(.coreML, options: opts("MLProgram", "ALL")), batch: nil),
            Variant(name: "cache path MLProgram CPUAndGPU", plan: cached, batch: nil),
            Variant(name: "0x030 + batch_size=1 (static)", plan: plan(.coreML, batch: 1), batch: 1),
            Variant(name: "0x030 + batch_size=8 (static)", plan: plan(.coreML, batch: 8), batch: 8),
            Variant(name: "0x038 + batch_size=1 (static-only)", plan: plan(.coreML, flags: 0x038, batch: 1), batch: 1),
            Variant(name: "0x000 NN + batch_size=1", plan: plan(.coreML, flags: 0x000, batch: 1), batch: 1),
            Variant(name: "0x011 CPUOnly + batch_size=1", plan: plan(.coreML, flags: 0x011, batch: 1), batch: 1),
        ]
        #else
        let variants = cpuVariant
        #endif

        var cpuTile: [Float] = []
        var cpuMap: [UInt8] = []
        let fullPage = ProcessInfo.processInfo.environment["OMR_SEGNET_DIAG_PAGE"] != "0"
        for v in variants {
            let t0 = Date()
            let s: ORTCSession
            do { s = try ORTCSession(modelURL: model, plan: v.plan) } catch {
                print("[segnet-diag] \(v.name): create FAILED \(error)")
                continue
            }
            let createMs = Date().timeIntervalSince(t0) * 1000
            let tb = v.batch ?? 1
            var line = String(format: "[segnet-diag] %@: create %.0f ms", v.name, createMs)
            do {
                let out = try s.run(inputs: ["input": Self.tileInput(page, width: w, y: best.y, x: best.x, batch: tb)],
                                    outputNames: ["output"])
                guard let o = out["output"] else { throw ORTCError.unknownName("output") }
                let (st, vals) = Self.stats(o)
                if cpuTile.isEmpty { cpuTile = vals }
                var maxDiff: Float = 0
                if vals.count == cpuTile.count {
                    for i in vals.indices where !(vals[i] - cpuTile[i]).isNaN { maxDiff = max(maxDiff, abs(vals[i] - cpuTile[i])) }
                }
                line += " | tile b=\(tb): \(st) max|diff vs CPU| \(maxDiff)"
            } catch {
                line += " | tile run FAILED \(error)"
            }
            if fullPage {
                do {
                    let t1 = Date()
                    let map = try SegNetSession(backend: s, tilesPerRun: v.batch ?? SegNetSession.batchSize)
                        .segment(preprocessed: page, width: w, height: h)
                    var counts = [Int](repeating: 0, count: SegNetSession.classCount)
                    for c in map { counts[Int(c)] += 1 }
                    if cpuMap.isEmpty { cpuMap = map }
                    let mismatch = zip(map, cpuMap).reduce(0) { $0 + ($1.0 != $1.1 ? 1 : 0) }
                    line += String(format: " | page %.0f ms counts %@ mismatch vs CPU %d", Date().timeIntervalSince(t1) * 1000,
                                   "\(counts)", mismatch)
                } catch {
                    line += " | page FAILED \(error)"
                }
            }
            print(line)
        }
        #else
        throw XCTSkip("ORT not linked")
        #endif
    }
}
