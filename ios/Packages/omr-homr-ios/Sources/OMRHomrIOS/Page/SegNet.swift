// SPDX-License-Identifier: AGPL-3.0-or-later
// Port of liebharc/homr @ 7d97c3cee4ad772b50266fdf9dc78bbf9064701e (AGPL-3.0):
//   homr/segmentation/inference_segnet.py  Segnet.run (fp16 model), extract_patch, inference, merge_patches
//   homr/main.py                           get_predictions (extract(preprocessed, step_size=320))
// Tiles: 320x320 windows every 320 px (last row/column clamped to the edge, overlapping), gray -> BGR
// (3 equal channels) as fp16 0..255 (no normalisation), batches of 8, argmax over the 6 classes per
// tile, then merge_patches: float32 mean of the overlapping class ids, truncated to int.
// Classes: 0 background, 1 stems_rests, 2 notehead, 3 clefs_keys, 4 staff, 5 symbols.

import Foundation

public final class SegNetSession: @unchecked Sendable {
    public static let inputName = "input"
    public static let outputName = "output"
    public static let windowSize = 320
    public static let stepSize = 320
    public static let batchSize = 8
    public static let classCount = 6

    /// CoreML EP legacy flags for SegNet: `0x000` = NeuralNetwork model format, all compute units (CPU, GPU
    /// and the Neural Engine on a device), dynamic shapes allowed; CPU EP stays registered as fallback.
    ///
    /// Why not the encoder's MLProgram `0x030`: SegNet's input (`batch_size`) and every `upsample_nearest2d`
    /// output have unbounded dimensions, which CoreML's MLProgram runtime rejects ("E5RT: … has unbounded
    /// dimension which is not supported") and ORT 1.24.2 then silently returns an all-zero output, so every
    /// pixel is class 0 and staff detection finds no noteheads. `SegNetCoreMLDiagTests` (CI run 36275275275,
    /// iOS simulator): 0x000 / 0x020 / 0x001 NeuralNetwork = CPU EP exactly (0 px, max |diff| 0.0, create
    /// 89–192 ms); 0x010 / 0x011 / 0x030 MLProgram and the provider-options / cache paths = all zeros.
    public static let coreMLLegacyFlags: UInt32 = 0x000

    public let backend: ORTSessionBackend
    /// Tiles per `run`. Results do not depend on it (tiles are independent).
    public let tilesPerRun: Int

    /// Production batch size measured on device (iPhone17,5, 2026-09-27): 32 tiles/dispatch ran
    /// ~10x slower per tile than 8 (segnet_run 13.8s for 20 tiles vs ~1.5s at batch 8 on the same
    /// 1170x1431 photo; consistent across two runs, so not a one-time compile — the ANE executes
    /// the [32,3,320,320] shape pathologically slowly). Kept for reference; do not use.
    public static let productionTilesPerRun = 32

    /// Sub-timings (ms) of the last `segment()` call, for device diagnostics. Reset each call.
    public private(set) var lastPackMs: Double = 0
    public private(set) var lastRunMs: Double = 0
    public private(set) var lastArgmaxMs: Double = 0
    /// `backend.run` ms of the first dispatch only (spots lazy per-shape CoreML compiles).
    public private(set) var lastFirstBatchRunMs: Double = 0
    public private(set) var lastTileCount: Int = 0
    public private(set) var lastBatchCount: Int = 0

    /// `backend`: the pinned SegNet fp16 model (`segnet_308-…_fp16.onnx`), `.coreML` (CPU fallback) on
    /// iOS, `.cpu` elsewhere.
    public init(backend: ORTSessionBackend, tilesPerRun: Int = SegNetSession.batchSize) {
        precondition(tilesPerRun >= 1)
        self.backend = backend
        self.tilesPerRun = tilesPerRun
    }

    /// Tile origins in homr's order (`for y_loop in range(0, max(h, win), step)`, same for x).
    static func tileOrigins(width w: Int, height h: Int) -> [(y: Int, x: Int)] {
        let win = windowSize, step = stepSize
        var out: [(Int, Int)] = []
        var yl = 0
        while yl < max(h, win) {
            let y = min(yl, h - win)
            var xl = 0
            while xl < max(w, win) {
                out.append((y, min(xl, w - win)))
                xl += step
            }
            yl += step
        }
        return out
    }

    /// Number of 320x320 SegNet windows homr runs on a `width x height` page.
    public static func tileCount(width: Int, height: Int) -> Int { tileOrigins(width: width, height: height).count }

    /// fp16 bits for 0...255 (exact in half precision).
    static let halfOfByte: [UInt16] = (0..<256).map { EncoderSession.float16Bits(fromFloat32Bits: Float($0).bitPattern) }

    /// half bits -> Float, for argmax (np.argmax on float16 compares the same values).
    static let floatOfHalf: [Float] = (0..<65536).map { EncoderContext.float32(fromFloat16Bits: UInt16($0)) }

    /// Run SegNet on 320x320 windows of a gray page and return one argmax map (uint8, 320*320) per origin.
    /// The short last batch is padded with repeats of its last tile so every dispatch has the same
    /// `[tilesPerRun, 3, 320, 320]` shape (avoids ANE dynamic-shape recompiles); padded outputs are
    /// discarded. Records `last*Ms` sub-timings for diagnostics.
    func runTiles(_ page: UnsafeBufferPointer<UInt8>, width w: Int, height h: Int,
                  origins: [(y: Int, x: Int)], each: (Int, [UInt8]) throws -> Void) throws {
        let win = Self.windowSize
        let plane = win * win
        let batch = tilesPerRun
        var packMs = 0.0, runMs = 0.0, argmaxMs = 0.0, batches = 0
        var firstBatchRunMs = 0.0
        var start = 0
        while start < origins.count {
            let n = min(batch, origins.count - start)
            let t0 = ProcessInfo.processInfo.systemUptime
            var input = Data(count: batch * 3 * plane * 2)
            input.withUnsafeMutableBytes { raw in
                let dst = raw.bindMemory(to: UInt16.self)
                let white = Self.halfOfByte[255]
                for b in 0..<batch {
                    let (y, x) = origins[start + min(b, n - 1)]
                    // extract_patch: 255-filled window, image part copied to its top-left
                    let y0 = max(y, 0), x0 = max(x, 0)
                    let y1 = min(y + win, h), x1 = min(x + win, w)
                    let base = b * 3 * plane
                    for py in 0..<win {
                        let rowBase = base + py * win
                        let sy = y0 + py
                        for px in 0..<win {
                            let sx = x0 + px
                            var v = white
                            if sy < y1 && sx < x1 { v = Self.halfOfByte[Int(page[sy * w + sx])] }
                            dst[rowBase + px] = v
                            dst[rowBase + plane + px] = v
                            dst[rowBase + 2 * plane + px] = v
                        }
                    }
                }
            }
            let t1 = ProcessInfo.processInfo.systemUptime
            let tensor = ORTTensor(type: .float16, shape: [batch, 3, win, win], data: input)
            let outs = try backend.run(inputs: [Self.inputName: tensor], outputNames: [Self.outputName])
            let t2 = ProcessInfo.processInfo.systemUptime
            guard let out = outs[Self.outputName] else {
                throw OMRError.sessionNotConfigured("SegNet returned no '\(Self.outputName)' tensor")
            }
            let expected = batch * Self.classCount * plane * 2
            guard out.type == .float16, out.data.count == expected else {
                throw OMRError.sessionNotConfigured(
                    "SegNet output \(out.type) \(out.shape) (\(out.data.count) B), expected fp16 [\(batch),6,320,320]")
            }
            try out.data.withUnsafeBytes { raw in
                let src = raw.bindMemory(to: UInt16.self)
                try Self.floatOfHalf.withUnsafeBufferPointer { f in
                    for b in 0..<batch {
                        var am = [UInt8](repeating: 0, count: plane)
                        let base = b * Self.classCount * plane
                        for i in 0..<plane {
                            // np.argmax: first maximum; a NaN wins at its first occurrence
                            var best = f[Int(src[base + i])]
                            var bi = 0
                            if !best.isNaN {
                                for c in 1..<Self.classCount {
                                    let v = f[Int(src[base + c * plane + i])]
                                    if v.isNaN { bi = c; break }
                                    if v > best { best = v; bi = c }
                                }
                            }
                            am[i] = UInt8(bi)
                        }
                        if b < n { try each(start + b, am) }
                    }
                }
            }
            let t3 = ProcessInfo.processInfo.systemUptime
            packMs += (t1 - t0) * 1000
            let batchRunMs = (t2 - t1) * 1000
            if batches == 0 { firstBatchRunMs = batchRunMs }
            runMs += batchRunMs
            argmaxMs += (t3 - t2) * 1000
            batches += 1
            start += n
        }
        lastPackMs = packMs
        lastRunMs = runMs
        lastArgmaxMs = argmaxMs
        lastFirstBatchRunMs = firstBatchRunMs
        lastTileCount = origins.count
        lastBatchCount = batches
    }

    /// `inference(...)` up to `merge_patches`: merged class map (uint8 0..5, width*height).
    /// Memory: two page-sized uint8 accumulators; tiles are merged as they arrive.
    /// `onTile(done, total)` runs after each tile is merged (on the calling thread).
    public func segment(
        preprocessed page: [UInt8], width w: Int, height h: Int, onTile: ((Int, Int) -> Void)? = nil
    ) throws -> [UInt8] {
        precondition(page.count == w * h)
        lastPackMs = 0; lastRunMs = 0; lastArgmaxMs = 0; lastFirstBatchRunMs = 0; lastTileCount = 0; lastBatchCount = 0
        let win = Self.windowSize
        let origins = Self.tileOrigins(width: w, height: h)
        var sum = [UInt8](repeating: 0, count: w * h)
        var weight = [UInt8](repeating: 0, count: w * h)
        var done = 0
        try page.withUnsafeBufferPointer { p in
            try runTiles(p, width: w, height: h, origins: origins) { idx, am in
                let (y, x) = origins[idx]
                let y0 = max(y, 0), x0 = max(x, 0)
                let y1 = min(y + win, h), x1 = min(x + win, w)
                for py in 0..<(y1 - y0) {
                    let row = (y0 + py) * w + x0
                    for px in 0..<(x1 - x0) {
                        sum[row + px] &+= am[py * win + px]
                        weight[row + px] &+= 1
                    }
                }
                done += 1
                onTile?(done, origins.count)
            }
        }
        var merged = [UInt8](repeating: 0, count: w * h)
        for i in 0..<(w * h) {
            let wt = weight[i] == 0 ? 1 : weight[i]
            if wt == 1 {
                merged[i] = sum[i]
            } else {
                let q = Float(sum[i]) / Float(wt)   // float32 mean, then astype(int64) truncation
                merged[i] = UInt8(q)
            }
        }
        return merged
    }
}

#if canImport(CONNXRuntime) || canImport(CONNXRuntimeApple)
extension SegNetSession {
    /// The ONE way to open the SegNet model: `.coreML` = CoreML EP with `coreMLLegacyFlags` (NeuralNetwork,
    /// all compute units) + CPU EP fallback; `.cpu` = plain CPU EP. Use this instead of
    /// `ORTCSession(modelURL:provider: .coreML)`, whose MLProgram default gives SegNet an all-zero output.
    ///
    /// - Parameters:
    ///   - provider: `.coreML` on Apple (throws `ORTCError.unsupportedProvider` on Linux), `.cpu` anywhere.
    ///   - cacheDirectory: accepted and IGNORED (no CoreML compiled-model cache for SegNet). ORT's
    ///     `ModelCacheDirectory` can only be set through the provider-options API, not the legacy flags
    ///     this configuration is verified with, and SegNet's NeuralNetwork create is ~0.1–0.2 s, so a cache
    ///     buys nothing. A silent no-op (not a throw) so an app that still passes a folder keeps working;
    ///     nothing is created in or read from it.
    ///   - intraOpThreads: see `ORTCSession.defaultIntraOpThreads`.
    public static func openBackend(
        modelURL: URL, provider: ORTProvider = .coreML, cacheDirectory: URL? = nil,
        intraOpThreads: Int = ORTCSession.defaultIntraOpThreads
    ) throws -> ORTCSession {
        #if !canImport(CONNXRuntimeApple)
        guard case .cpu = provider else { throw ORTCError.unsupportedProvider("\(provider)") }
        #endif
        return try ORTCSession(modelURL: modelURL, plan: sessionPlan(provider: provider, intraOpThreads: intraOpThreads))
    }

    /// Session plan for `openBackend`: legacy flags `coreMLLegacyFlags` with `.coreML`, never provider
    /// options, never a cache directory or embedded cache key, model opened by path.
    static func sessionPlan(provider: ORTProvider, intraOpThreads: Int) -> ORTCSession.SessionPlan {
        var plan = ORTCSession.SessionPlan(provider: provider, intraOpThreads: intraOpThreads)
        if case .coreML = provider { plan.coreMLLegacyFlags = coreMLLegacyFlags }
        return plan
    }
}
#endif
