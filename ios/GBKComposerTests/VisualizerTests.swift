import XCTest
@testable import GBKComposer

final class PianoRollMathTests: XCTestCase {
    // Preview units: [track, start 0...1000, len 0...1000, pitch]; 40 s song.
    let preview = SongPreview(tracks: ["#4fc3f7", "#ffb74d"], lo: 60, hi: 72, end: 61440, duration: nil,
                              notes: [[0, 0, 100, 60], [1, 500, 10, 72], [0, 990, 10, 61]])

    func testConstantsMatchWeb() {
        // web VIZ, gbk #108 / db68404
        XCTAssertEqual(FeedVisuals.playheadFraction, 0.25)
        XCTAssertEqual(FeedVisuals.windowSeconds, 4)
        XCTAssertEqual(FeedVisuals.rollFraction, 0.62)
        XCTAssertEqual(FeedVisuals.fftSize, 2048)
        XCTAssertEqual(FeedVisuals.barCount, 48)
        XCTAssertEqual(FeedVisuals.minHz, 40)
        XCTAssertEqual(FeedVisuals.maxHz, 16_000)
        XCTAssertEqual(FeedVisuals.decaySeconds, 0.15)
        XCTAssertEqual(FeedVisuals.maxFrameDt, 0.1)
        XCTAssertEqual(FeedVisuals.waveformPoints, 256)
        XCTAssertEqual(FeedVisuals.pastAlpha, 0.35)
        XCTAssertEqual(FeedVisuals.upcomingAlpha, 0.8)
        XCTAssertEqual(FeedVisuals.activeBrighten, 0.45)
    }

    func testUnitsConvertToSeconds() {
        let n = PianoRollMath.notes(from: preview, durationSeconds: 40)
        XCTAssertEqual(n[0], RollNote(track: 0, start: 0, length: 4, pitch: 60))
        XCTAssertEqual(n[1].start, 20, accuracy: 1e-9)
        XCTAssertEqual(n[1].length, 0.4, accuracy: 1e-9)
        XCTAssertTrue(PianoRollMath.notes(from: preview, durationSeconds: 0).isEmpty)
    }

    func testActiveNoteSitsOnPlayhead() {
        let notes = PianoRollMath.notes(from: preview, durationSeconds: 40)
        let w = PianoRollMath.window(notes: notes, time: 2, lo: 60, hi: 72)
        XCTAssertEqual(w.count, 1)
        XCTAssertEqual(w[0].state, .active)
        XCTAssertEqual(w[0].x0, -0.25, accuracy: 1e-9)
        XCTAssertEqual(w[0].x1, 0.75, accuracy: 1e-9)
    }

    func testPastNotesStayOneSecondThenLeave() {
        let notes = PianoRollMath.notes(from: preview, durationSeconds: 40)
        let past = PianoRollMath.window(notes: notes, time: 4.5, lo: 60, hi: 72)
        XCTAssertEqual(past.map(\.state), [.past], "ended 0.5 s ago: still in the 1 s past margin, dimmed")
        XCTAssertTrue(PianoRollMath.window(notes: notes, time: 5.5, lo: 60, hi: 72).isEmpty)
        let up = PianoRollMath.window(notes: notes, time: 18, lo: 60, hi: 72)
        XCTAssertEqual(up.map(\.note.pitch), [72])
        XCTAssertEqual(up[0].state, .upcoming)
        XCTAssertEqual(up[0].x0, 0.75, accuracy: 1e-9)
    }

    func testNoLoopWrap() {
        let notes = PianoRollMath.notes(from: preview, durationSeconds: 40)
        XCTAssertEqual(PianoRollMath.window(notes: notes, time: 38, lo: 60, hi: 72).map(\.note.pitch), [61])
    }

    func testPitchRowsPaddedWithMinimumSpan() {
        XCTAssertEqual(PianoRollMath.pitchRange(lo: 64, hi: 64).lo, 62)
        XCTAssertEqual(PianoRollMath.pitchRange(lo: 64, hi: 64).hi, 73)   // lo-2 + 11
        XCTAssertEqual(PianoRollMath.pitchRange(lo: 60, hi: 84).hi, 86)   // hi + 2
        let w = PianoRollMath.window(notes: [RollNote(track: 0, start: 0, length: 1, pitch: 64)], time: 0.5, lo: 64, hi: 64)
        XCTAssertEqual(w[0].rows, 12)
        XCTAssertEqual(w[0].row, 9) // 73 − 64, from the top
    }
}

final class SpectrumTests: XCTestCase {
    func testLogBandsMatchWebBinning() {
        let bands = SpectrumMath.logBands(fftSize: 2048, sampleRate: 48_000)
        XCTAssertEqual(bands.count, 48)
        XCTAssertTrue(bands.allSatisfy { !$0.isEmpty })
        // 40 Hz / 24 kHz · 1024 = 1.7 → bin 1; last band ends at ceil(16k/24k · 1024) = 683
        XCTAssertEqual(bands.first?.lowerBound, 1)
        XCTAssertEqual(bands.last?.upperBound, 683)
        XCTAssertTrue(zip(bands, bands.dropFirst()).allSatisfy { $0.lowerBound <= $1.lowerBound })
        XCTAssertGreaterThan(bands.last!.count, bands[0].count)
    }

    func testLevelsPickBandWithEnergy() {
        let bands = SpectrumMath.logBands(fftSize: 2048, sampleRate: 44_100)
        var p = [Float](repeating: 1e-20, count: 1024)
        p[100] = 1e-4 // -40 dB
        let lv = SpectrumMath.levels(powers: p, bands: bands)
        let hit = bands.firstIndex { $0.contains(100) }!
        XCTAssertEqual(lv.firstIndex(of: lv.max()!), hit)
        XCTAssertEqual(lv[hit], (-40 + 100) / 70, accuracy: 1e-5)
        XCTAssertEqual(lv[0], 0)
    }

    func testAttackInstantDecay150ms() {
        let up = SpectrumMath.smooth(previous: [0], target: [1], dt: 1 / 60)
        XCTAssertEqual(up[0], 1)
        let down = SpectrumMath.smooth(previous: [1], target: [0.2], dt: 0.05)
        XCTAssertEqual(down[0], Float(exp(-1.0 / 3)), accuracy: 1e-6, "web: level *= exp(-dt/150ms)")
        let capped = SpectrumMath.smooth(previous: [1], target: [0], dt: 2)
        XCTAssertEqual(capped[0], Float(exp(-0.1 / 0.15)), accuracy: 1e-6, "dt capped at 100 ms")
    }

    func testFFTPeakLandsInExpectedBar() {
        let analyzer = SpectrumAnalyzer()
        let rate = 44_100.0, f = 1_000.0
        let samples = (0..<2048).map { Float(sin(2 * .pi * f * Double($0) / rate)) }
        let power = analyzer.powerSpectrum(samples)
        let peakBin = power.indices.max { power[$0] < power[$1] }!
        XCTAssertEqual(Double(peakBin) * rate / 2048, f, accuracy: rate / 2048)
        let bands = SpectrumMath.logBands(fftSize: 2048, sampleRate: rate)
        let lv = SpectrumMath.levels(powers: power, bands: bands)
        XCTAssertEqual(lv.firstIndex(of: lv.max()!), bands.firstIndex { $0.contains(peakBin) })
    }

    func testWaveformSamplesEvenlyLikeWeb() {
        XCTAssertEqual(WaveformMath.points([0, 0.5, -0.9, 0.1], count: 2), [0, -0.9])
        XCTAssertEqual(WaveformMath.points([Float](repeating: 0.1, count: 2048)).count, 256)
        XCTAssertEqual(WaveformMath.points([], count: 3), [0, 0, 0])
    }
}

/// Real audio, no mocks: decode a bundled WAV / mp3 (220 Hz + 1 kHz, 2 s) through the same DecodedPCM path the
/// feed uses, then read bars + waveform at a playhead exactly like the card's Canvas does each frame.
final class RealAudioVisualizerTests: XCTestCase {
    func testDecodedWavDrivesBarsAndWaveform() throws { try check(ext: "wav") }
    /// MP3 is only the fallback for songs without `media.wav`.
    func testDecodedMp3FallbackDrivesBarsAndWaveform() throws { try check(ext: "mp3") }

    private func check(ext: String) throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "viz_chord", withExtension: ext, subdirectory: "Fixtures")
                                ?? Bundle(for: Self.self).url(forResource: "viz_chord", withExtension: ext))
        let pcm = try DecodedPCM.decode(fileURL: url)
        let buffer = try XCTUnwrap(pcm.buffer, "playback buffer is the same PCM the analyzer reads")
        XCTAssertEqual(Int(buffer.frameLength), pcm.samples.count)
        XCTAssertGreaterThan(pcm.samples.count, Int(pcm.sampleRate * 1.5), "decoded ~2 s of audio")

        let analyzer = SpectrumAnalyzer()
        var t = 1.0
        analyzer.source = pcm
        analyzer.clock = { t }
        let bars = analyzer.bars(now: 0)
        XCTAssertEqual(bars.count, FeedVisuals.barCount)
        XCTAssertGreaterThan(bars.max() ?? 0, 0.5, "spectrum not flat while playing")
        let bands = SpectrumMath.logBands(fftSize: FeedVisuals.fftSize, sampleRate: pcm.sampleRate)
        for f in [220.0, 1000.0] {
            let bin = Int(f / pcm.sampleRate * Double(FeedVisuals.fftSize))
            let b = try XCTUnwrap(bands.firstIndex { $0.contains(bin) })
            XCTAssertGreaterThan(bars[b], 0.5, "\(f) Hz bar lit")
        }
        let wave = analyzer.waveform()
        XCTAssertEqual(wave.count, FeedVisuals.waveformPoints)
        XCTAssertGreaterThan(wave.map(abs).max() ?? 0, 0.2, "waveform has amplitude")

        // Before decode (no source) and past the end: silence, as on a non-playing card.
        t = 10
        XCTAssertEqual(analyzer.waveform().map(abs).max(), 0)
        analyzer.source = nil
        XCTAssertNil(analyzer.latestSamples())
    }
}
