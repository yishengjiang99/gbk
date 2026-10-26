import Foundation

/// Feed now-playing viz constants, mirrored 1:1 from web `VIZ` in src/components/social/LiveRoll.tsx
/// (gbk #108, db68404; spec https://github.com/yishengjiang99/gbk/issues/108#issuecomment-6402713315).
enum FeedVisuals {
    static let windowSeconds: Double = 4
    static let playheadFraction: Double = 0.25
    /// Bars + waveform overlay height share, anchored to the bottom of the full-height roll.
    static let overlayFraction: Double = 0.38
    static let waveAlpha: Double = 0.8
    static let idleAlpha: Double = 0.5
    static let pitchPad: Double = 2
    static let minPitchSpan: Double = 12
    static let noteGap: Double = 1
    static let minNoteSize: Double = 2
    static let fftSize = 2048
    static let barCount = 48
    static let minHz: Double = 40
    static let maxHz: Double = 16_000
    /// Bars: instant attack, `level *= exp(-dt / 150 ms)`, dt capped at 100 ms.
    static let decaySeconds: Double = 0.15
    static let maxFrameDt: Double = 0.1
    static let barAlpha: Double = 0.35
    static let waveformPoints = 256
    /// Active note = track colour mixed 45% toward white, 1 px outline in the playhead colour.
    static let activeBrighten: Double = 0.45
    static let pastAlpha: Double = 0.35
    static let upcomingAlpha: Double = 0.8
    /// Web falls back to 30 s when the audio duration is unknown (static frame).
    static let fallbackDuration: Double = 30
}

/// Preview notes are `[track, start, len, pitch]` with start/len on 0...1000, so seconds = value / 1000 · duration.
struct RollNote: Equatable {
    let track: Int
    let start: Double   // seconds
    let length: Double  // seconds
    let pitch: Int
}

enum NoteState: Equatable { case past, active, upcoming }

struct PlacedNote: Equatable {
    let note: RollNote
    /// Left/right edges as fractions of width (may extend past 0...1).
    let x0: Double
    let x1: Double
    /// Pitch row index from the top, and the total row count.
    let row: Int
    let rows: Int
    let state: NoteState
    var isActive: Bool { state == .active }
}

enum PianoRollMath {
    static func notes(from preview: SongPreview?, durationSeconds: Double) -> [RollNote] {
        guard let raw = preview?.notes, durationSeconds > 0 else { return [] }
        return raw.compactMap { n in
            guard n.count >= 4 else { return nil }
            return RollNote(track: Int(n[0]), start: n[1] / 1000 * durationSeconds,
                            length: n[2] / 1000 * durationSeconds, pitch: Int(n[3]))
        }
    }

    /// Actual min/max pitch of the notes (preview `lo`/`hi` can be wider than the drawn notes); fallback when empty.
    static func noteSpan(_ notes: [RollNote], fallbackLo: Double, fallbackHi: Double) -> (lo: Double, hi: Double) {
        guard let l = notes.map(\.pitch).min(), let h = notes.map(\.pitch).max() else { return (fallbackLo, fallbackHi) }
        return (Double(l), Double(h))
    }

    /// Pitch range drawn: lo − 2 … max(hi + 2, lo − 2 + 11).
    static func pitchRange(lo: Double, hi: Double) -> (lo: Double, hi: Double) {
        let l = lo - FeedVisuals.pitchPad
        return (l, max(hi + FeedVisuals.pitchPad, l + FeedVisuals.minPitchSpan - 1))
    }

    /// Web drawRoll: notes intersecting the 4 s window (1 s past, 3 s ahead). No loop wrap.
    static func window(notes: [RollNote], time t: Double, lo: Double, hi: Double,
                       windowSeconds: Double = FeedVisuals.windowSeconds,
                       playhead: Double = FeedVisuals.playheadFraction) -> [PlacedNote] {
        let (l, h) = pitchRange(lo: lo, hi: hi)
        let rows = Int(h - l + 1)
        return notes.compactMap { n in
            let t0 = n.start, t1 = n.start + n.length
            let x0 = playhead + (t0 - t) / windowSeconds, x1 = playhead + (t1 - t) / windowSeconds
            guard x1 >= 0, x0 <= 1 else { return nil }
            let state: NoteState = (t0 <= t && t1 > t) ? .active : (t1 <= t ? .past : .upcoming)
            return PlacedNote(note: n, x0: x0, x1: x1, row: Int(h) - n.pitch, rows: rows, state: state)
        }
    }
}

enum SpectrumMath {
    /// Web LiveRoll binning: band b spans f0 = fMin·(fMax/fMin)^(b/48) … f1 = …^((b+1)/48);
    /// i0 = floor(f0/nyquist·n), i1 = max(i0+1, ceil(f1/nyquist·n)), both clamped to n bins.
    static func logBands(bars: Int = FeedVisuals.barCount, fftSize: Int = FeedVisuals.fftSize, sampleRate: Double,
                         minHz: Double = FeedVisuals.minHz, maxHz: Double = FeedVisuals.maxHz) -> [Range<Int>] {
        let n = fftSize / 2, ny = sampleRate / 2
        return (0..<bars).map { b in
            let f0 = minHz * pow(maxHz / minHz, Double(b) / Double(bars))
            let f1 = minHz * pow(maxHz / minHz, Double(b + 1) / Double(bars))
            let i0 = min(n - 1, Int((f0 / ny * Double(n)).rounded(.down)))
            let i1 = min(n, max(i0 + 1, Int((f1 / ny * Double(n)).rounded(.up))))
            return i0..<i1
        }
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

    /// Web: `levels[b] = v >= levels[b] ? v : levels[b] * exp(-dt/150ms)`, dt capped at 100 ms.
    static func smooth(previous: [Float], target: [Float], dt: Double, decay: Double = FeedVisuals.decaySeconds) -> [Float] {
        let k = Float(exp(-min(max(dt, 0), FeedVisuals.maxFrameDt) / decay))
        return zip(previous, target).map { old, new in new >= old ? new : old * k }
    }
}

enum WaveformMath {
    /// Web: 256 points, sample k = buffer[floor(k/256 · count)].
    static func points(_ samples: [Float], count points: Int = FeedVisuals.waveformPoints) -> [Float] {
        guard !samples.isEmpty, points > 0 else { return [Float](repeating: 0, count: max(points, 0)) }
        return (0..<points).map { k in min(max(samples[k * samples.count / points], -1), 1) }
    }
}
