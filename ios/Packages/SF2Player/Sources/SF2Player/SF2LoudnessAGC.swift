// SPDX-License-Identifier: AGPL-3.0-or-later
// gbk addition: live loudness control for real-time playback (no prerender).
import Foundation
import SF2Engine

/// Slow live AGC toward a loudness target (default -16 LUFS, gbk's export target). Feed it the output
/// (`push`), it measures BS.1770 loudness over `windowSeconds` blocks and returns a new master-bus gain
/// (dB, applied before the compressor + brickwall limiter, so boosts never clip). Steps are capped
/// so changes stay gentle; near-silence (< -50 LUFS) leaves the gain alone.
public final class SF2LoudnessAGC {
    public let targetLufs: Double
    public let windowSeconds: Double
    public let maxStepDb: Double
    public let range: ClosedRange<Double>
    public private(set) var gainDb: Double
    public private(set) var lastMeasuredLufs: Double?
    private let sampleRate: Double
    private var meter: SF2LoudnessMeter
    private var frames = 0

    /// `initialGainDb` +4: feed songs render at -20…-27 LUFS with the engine default (-3 dB), so start near the median.
    public init(sampleRate: Double, targetLufs: Double = -16, initialGainDb: Double = 4, windowSeconds: Double = 2,
                maxStepDb: Double = 4, range: ClosedRange<Double> = -9 ... 18) {
        self.sampleRate = sampleRate; self.targetLufs = targetLufs; self.windowSeconds = windowSeconds
        self.maxStepDb = maxStepDb; self.range = range
        gainDb = min(max(initialGainDb, range.lowerBound), range.upperBound)
        meter = SF2LoudnessMeter(sampleRate: sampleRate)
    }

    public func reset(gainDb g: Double? = nil) {
        if let g { gainDb = min(max(g, range.lowerBound), range.upperBound) }
        meter = SF2LoudnessMeter(sampleRate: sampleRate); frames = 0; lastMeasuredLufs = nil
    }

    /// Returns the new gain when it changed at the end of a window, else nil.
    public func push(_ l: UnsafePointer<Float>, _ r: UnsafePointer<Float>, _ n: Int) -> Double? {
        meter.push(l, r, n)
        frames += n
        guard Double(frames) >= windowSeconds * sampleRate else { return nil }
        let lufs = meter.result().integratedLufs
        meter = SF2LoudnessMeter(sampleRate: sampleRate); frames = 0
        guard lufs.isFinite, lufs > -50 else { return nil }
        lastMeasuredLufs = lufs
        // The measured block already includes the current gain; move toward target, step-limited.
        let step = min(max(targetLufs - lufs, -maxStepDb), maxStepDb)
        guard abs(step) >= 0.5 else { return nil }
        let g = min(max(gainDb + step, range.lowerBound), range.upperBound)
        guard g != gainDb else { return nil }
        gainDb = g
        return g
    }
}
