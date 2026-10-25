import Foundation

/// Shared feed-card visual constants, mirrored from web src/components/social/LiveRoll.tsx
/// (PLAYHEAD_X = 0.25, WINDOW_SEC = 4, BARS = 48, BAR_DECAY_MS = 150, F_LO = 40, F_HI = 16000).
enum FeedVisuals {
    /// Playhead x as a fraction of card width.
    static let playheadFraction: Double = 0.25
    /// Seconds visible across the full card width (web WINDOW_SEC): 1 s behind the playhead, 3 s ahead.
    static let windowSeconds: Double = 4
    static let barCount = 48
    /// Attack is instant; levels fall with this time constant.
    static let decaySeconds: Double = 0.15
    static let minHz: Double = 40
    static let maxHz: Double = 16_000
    static let fftSize = 2048
    /// Web LiveRoll: bar i colour = hsl(200 + i/48·140, 85%, 58%); active notes brightened 45% toward white with a glow.
    static let barHueStart: Double = 200
    static let barHueSpan: Double = 140
    static let activeBrighten: Double = 0.45
    /// Waveform (oscilloscope) points drawn per frame.
    static let waveformPoints = 256
}

/// Piano-roll note windowing. Preview notes are `[track, start, len, pitch]` with `start`/`len`
/// in 0...1000 (fractions of the whole song, see src/agent/piano-roll-preview.ts), so seconds = value / 1000 · duration.
struct RollNote: Equatable {
    let track: Int
    let start: Double   // seconds
    let length: Double  // seconds
    let pitch: Int
}

struct PlacedNote: Equatable {
    let note: RollNote
    /// Left and right edges as fractions of width (may extend past 0...1 when partially visible).
    let x0: Double
    let x1: Double
    /// Top edge and height as fractions of the roll height.
    let yTop: Double
    let height: Double
    let isActive: Bool
}

enum PianoRollMath {
    /// Web LiveRoll: notes shorter than this are drawn at this length.
    static let minNoteSeconds = 0.03

    static func notes(from preview: SongPreview?, durationSeconds: Double) -> [RollNote] {
        guard let raw = preview?.notes, durationSeconds > 0 else { return [] }
        return raw.compactMap { n in
            guard n.count >= 4 else { return nil }
            return RollNote(track: Int(n[0]), start: n[1] / 1000 * durationSeconds,
                            length: max(minNoteSeconds, n[2] / 1000 * durationSeconds), pitch: Int(n[3]))
        }
    }

    /// Notes visible at `time`: current and upcoming notes moving right-to-left toward the playhead.
    /// Notes that have finished (end <= time) disappear. The song loops, so copies one duration later are included.
    /// Pitch rows: span = max(12, hi - lo + 1), centred, highest pitch at the top (web LiveRoll).
    static func window(notes: [RollNote], time: Double, lo: Double, hi: Double, durationSeconds: Double? = nil,
                       windowSeconds: Double = FeedVisuals.windowSeconds,
                       playhead: Double = FeedVisuals.playheadFraction) -> [PlacedNote] {
        let viewStart = time - windowSeconds * playhead
        let viewEnd = viewStart + windowSeconds
        let rows = hi - lo + 1
        let span = max(12, rows)
        let nh = 1 / span
        let off = (span - rows) * nh / 2
        let offsets = (durationSeconds ?? 0) > 0 ? [0, durationSeconds!] : [0]
        var out: [PlacedNote] = []
        for n in notes {
            for shift in offsets {
                let s0 = n.start + shift, end = s0 + n.length
                guard end > time, s0 < viewEnd else { continue }
                out.append(PlacedNote(note: n, x0: (s0 - viewStart) / windowSeconds, x1: (end - viewStart) / windowSeconds,
                                      yTop: (hi - Double(n.pitch)) * nh + off, height: nh * 0.85,
                                      isActive: s0 <= time && time < end))
            }
        }
        return out
    }
}

enum SpectrumMath {
    /// FFT bin ranges for `bars` log-spaced bands between minHz and maxHz. Every band has at least one bin,
    /// bands are contiguous and increasing, and bin 0 (DC) is never used.
    static func logBands(bars: Int = FeedVisuals.barCount, fftSize: Int = FeedVisuals.fftSize, sampleRate: Double,
                         minHz: Double = FeedVisuals.minHz, maxHz: Double = FeedVisuals.maxHz) -> [Range<Int>] {
        let binCount = fftSize / 2
        let hzPerBin = sampleRate / Double(fftSize)
        let top = min(maxHz, sampleRate / 2)
        let ratio = top / minHz
        var bands: [Range<Int>] = []
        var lower = max(1, Int((minHz / hzPerBin).rounded(.down)))
        for i in 0..<bars {
            let fHi = minHz * pow(ratio, Double(i + 1) / Double(bars))
            var upper = Int((fHi / hzPerBin).rounded(.up))
            upper = min(max(upper, lower + 1), binCount)
            if lower >= binCount { lower = binCount - 1; upper = binCount }
            bands.append(lower..<upper)
            lower = upper
        }
        return bands
    }

    /// Per band: max power over its bins → 0...1 by mapping dB from `minDB`...`maxDB`
    /// (the Web Audio AnalyserNode defaults, -100...-30 dB, which web LiveRoll reads via getByteFrequencyData).
    static func levels(powers: [Float], bands: [Range<Int>], minDB: Float = -100, maxDB: Float = -30) -> [Float] {
        bands.map { r in
            let slice = r.clamped(to: 0..<powers.count)
            guard !slice.isEmpty else { return 0 }
            var peak: Float = 0
            for i in slice { peak = max(peak, powers[i]) }
            let db = 10 * log10(max(peak, 1e-20))
            return min(max((db - minDB) / (maxDB - minDB), 0), 1)
        }
    }

    /// Instant attack, exponential decay with time constant `decay`.
    static func smooth(previous: [Float], target: [Float], dt: Double, decay: Double = FeedVisuals.decaySeconds) -> [Float] {
        let k = Float(exp(-max(dt, 0) / decay))
        return zip(previous, target).map { old, new in new >= old ? new : new + (old - new) * k }
    }
}

enum WaveformMath {
    /// Downsample a time-domain buffer to `points` values in -1...1 (peak-preserving: the larger-magnitude sample per bucket).
    static func points(_ samples: [Float], count points: Int = FeedVisuals.waveformPoints) -> [Float] {
        guard !samples.isEmpty, points > 0 else { return [Float](repeating: 0, count: max(points, 0)) }
        let bucket = max(1, samples.count / points)
        return (0..<points).map { i in
            let a = min(i * bucket, samples.count - 1), b = min(a + bucket, samples.count)
            var v: Float = 0
            for j in a..<b where abs(samples[j]) > abs(v) { v = samples[j] }
            return min(max(v, -1), 1)
        }
    }
}
