// SPDX-License-Identifier: AGPL-3.0-or-later
import CSF2Atomics
import Foundation

/// Raw level accumulated by the audio thread since the previous `take` (linear, full scale = 1).
public struct SF2MeterReading: Equatable, Sendable {
    public var peakL: Float
    public var peakR: Float
    public var rmsL: Float
    public var rmsR: Float
    /// Frames rendered since the previous reading (0 = no audio callback ran).
    public var frames: Int

    public init(peakL: Float = 0, peakR: Float = 0, rmsL: Float = 0, rmsR: Float = 0, frames: Int = 0) {
        self.peakL = peakL; self.peakR = peakR; self.rmsL = rmsL; self.rmsR = rmsR; self.frames = frames
    }

    public static let silent = SF2MeterReading()
}

/// Meter math shared by the render thread (block stats) and the UI (dBFS, bar fraction).
public enum SF2LevelMath {
    /// Floor of the meter scale in dBFS; anything quieter shows as empty.
    public static let floorDB: Float = -60

    /// Peak |x| and Σx² of one channel block. No allocation; safe on the audio thread.
    @inline(__always)
    public static func blockStats(_ p: UnsafePointer<Float>, _ count: Int) -> (peak: Float, sumSq: Double) {
        var peak: Float = 0
        var sum: Double = 0
        for i in 0 ..< count {
            let x = p[i]
            let a = abs(x)
            if a > peak { peak = a }
            sum += Double(x) * Double(x)
        }
        return (peak, sum)
    }

    public static func rms(sumSq: Double, frames: Int) -> Float {
        frames > 0 && sumSq > 0 ? Float((sumSq / Double(frames)).squareRoot()) : 0
    }

    /// 20·log10(linear), clamped to `floor` (silence → floor).
    public static func dbfs(_ linear: Float, floor: Float = floorDB) -> Float {
        guard linear > 0, linear.isFinite else { return floor }
        return max(floor, 20 * log10f(linear))
    }

    /// Bar length 0...1, linear in dB between `floor` and 0 dBFS (clipped above 0 dBFS).
    public static func fraction(db: Float, floor: Float = floorDB) -> Float {
        guard db.isFinite else { return 0 }
        return min(1, max(0, (db - floor) / -floor))
    }
}

/// Displayed meter state (dBFS, `SF2LevelMath.floorDB` = empty).
public struct SF2MeterLevels: Equatable, Sendable {
    public var rmsL: Float
    public var rmsR: Float
    public var peakL: Float
    public var peakR: Float

    public init(rmsL: Float = SF2LevelMath.floorDB, rmsR: Float = SF2LevelMath.floorDB,
                peakL: Float = SF2LevelMath.floorDB, peakR: Float = SF2LevelMath.floorDB) {
        self.rmsL = rmsL; self.rmsR = rmsR; self.peakL = peakL; self.peakR = peakR
    }

    public static let silent = SF2MeterLevels()
    public var isSilent: Bool { max(rmsL, rmsR, peakL, peakR) <= SF2LevelMath.floorDB }
}

/// Meter ballistics: RMS bar attacks instantly and falls at `rmsFallDBPerSec`; the peak marker
/// holds for `peakHoldSec`, then falls at `peakFallDBPerSec`. Pure value type (unit-tested).
public struct SF2MeterBallistics: Equatable, Sendable {
    public var rmsFallDBPerSec: Float = 40
    public var peakHoldSec: Double = 1.0
    public var peakFallDBPerSec: Float = 24
    public private(set) var levels = SF2MeterLevels.silent
    private var holdL: Double = 0
    private var holdR: Double = 0

    public init() {}

    /// Advances by `dt` seconds with the raw reading accumulated over that interval.
    @discardableResult
    public mutating func update(_ r: SF2MeterReading, dt: Double) -> SF2MeterLevels {
        let dt = max(0, min(dt, 0.5))
        let fall = Float(dt)
        let floor = SF2LevelMath.floorDB
        let hasAudio = r.frames > 0
        func bar(_ old: Float, _ linear: Float) -> Float {
            let new = hasAudio ? SF2LevelMath.dbfs(linear) : floor
            return new >= old ? new : max(new, old - rmsFallDBPerSec * fall, floor)
        }
        func peak(_ old: Float, _ linear: Float, _ hold: inout Double) -> Float {
            let new = hasAudio ? SF2LevelMath.dbfs(linear) : floor
            if new >= old { hold = peakHoldSec; return new }
            if hold > 0 { hold -= dt; return old }
            return max(new, old - peakFallDBPerSec * fall, floor)
        }
        levels.rmsL = bar(levels.rmsL, r.rmsL)
        levels.rmsR = bar(levels.rmsR, r.rmsR)
        levels.peakL = peak(levels.peakL, r.peakL, &holdL)
        levels.peakR = peak(levels.peakR, r.peakR, &holdR)
        return levels
    }
}

/// Lock-free accumulator written by the render thread, drained by the UI.
final class SF2MeterAccumulator {
    let m: UnsafeMutablePointer<sf2_meter>

    init() {
        m = .allocate(capacity: 1)
        m.initialize(to: sf2_meter())
    }

    deinit { m.deallocate() }

    /// Audio thread: one call per render callback.
    @inline(__always)
    func add(_ l: UnsafePointer<Float>, _ r: UnsafePointer<Float>, _ count: Int) {
        guard count > 0 else { return }
        let a = SF2LevelMath.blockStats(l, count)
        let b = SF2LevelMath.blockStats(r, count)
        sf2_meter_add(m, a.peak, b.peak, a.sumSq, b.sumSq, UInt64(count))
    }

    /// UI thread: everything since the previous take; resets the accumulator.
    func take() -> SF2MeterReading {
        var pl: Float = 0, pr: Float = 0, sl: Double = 0, sr: Double = 0, n: UInt64 = 0
        sf2_meter_take(m, &pl, &pr, &sl, &sr, &n)
        let frames = Int(n)
        return SF2MeterReading(peakL: pl, peakR: pr,
                               rmsL: SF2LevelMath.rms(sumSq: sl, frames: frames),
                               rmsR: SF2LevelMath.rms(sumSq: sr, frames: frames),
                               frames: frames)
    }
}

/// UI-side meter: drains the core's accumulator and applies ballistics. Call `update(now:)` from
/// one thread (e.g. a 30 Hz `TimelineView`); never blocks the audio thread.
public final class SF2LevelMeter {
    public private(set) var ballistics = SF2MeterBallistics()
    public var levels: SF2MeterLevels { ballistics.levels }
    weak var core: SF2RealtimeCore?
    private var last: TimeInterval?

    public init() {}

    /// Drains the audio-thread accumulator and advances ballistics to `now` (seconds, monotonic).
    @discardableResult
    public func update(now: TimeInterval) -> SF2MeterLevels {
        let reading = core?.takeMeterReading() ?? .silent
        let dt = last.map { now - $0 } ?? 0
        last = now
        return ballistics.update(reading, dt: dt)
    }

    public func reset() {
        _ = core?.takeMeterReading()
        ballistics = SF2MeterBallistics()
        last = nil
    }
}
