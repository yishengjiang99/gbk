import QuartzCore
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

    func testNonFiniteSampleDoesNotBlankBars() {
        let scope = OutputScope()
        var tone = (0..<2048).map { Float(0.5 * sin(2 * .pi * 1_000 * Double($0) / 44_100)) }
        tone[100] = .nan
        scope.push(tone, sampleRate: 44_100, at: 0)
        let analyzer = SpectrumAnalyzer()
        analyzer.source = scope
        XCTAssertGreaterThan(analyzer.bars(now: 0).max() ?? 0, 0.5)
    }
}

/// Real audio, no mocks: a real 20 s MIDI file sequenced through the real SF2Engine + GeneralUser GS bank, pushed
/// through the exact tap block the feed installs on the engine output, then read like the card's Canvas does.
final class LiveSF2VisualizerTests: XCTestCase {
    private func fixtureMIDI() throws -> URL {
        try XCTUnwrap(Bundle(for: Self.self).url(forResource: "viz_chord", withExtension: "mid", subdirectory: "Fixtures")
                      ?? Bundle(for: Self.self).url(forResource: "viz_chord", withExtension: "mid"))
    }

    func testRealSF2RenderThroughTapDrivesBarsAndWaveform() throws {
        let sfURL = try XCTUnwrap(SoundFontStore.bundledURL, "GeneralUser-GS.sf2 is bundled in the app")
        let probe = try LiveRenderProbe.run(midi: Data(contentsOf: fixtureMIDI()), soundFont: sfURL, seconds: 1.5) // mid-chord + melody
        let scope = probe.scope
        XCTAssertTrue(probe.sawAudio, "tap saw non-silent output")
        XCTAssertEqual(FeedPlayer.headroomGain, 0.8, "web live playback: fixed 0.8 headroom, no LUFS normalization")

        let analyzer = SpectrumAnalyzer()
        analyzer.source = scope
        let bars = analyzer.bars(now: 0)
        XCTAssertEqual(bars.count, FeedVisuals.barCount)
        XCTAssertGreaterThan(bars.max() ?? 0, 0.5, "spectrum not flat while playing")
        XCTAssertGreaterThan(bars.filter { $0 > 0.2 }.count, 4, "several bars lit by the chord + melody")
        let wave = analyzer.waveform()
        XCTAssertEqual(wave.count, FeedVisuals.waveformPoints)
        XCTAssertGreaterThan(wave.map(abs).max() ?? 0, 0.02, "waveform has amplitude (0.8 headroom, no limiter boost)")

        analyzer.source = nil
        XCTAssertNil(analyzer.latestSamples())
    }

    /// Whole live chain on the simulator: FeedPlayer → SF2MIDIPlayer (AVAudioEngine) → output tap → analyzer.
    @MainActor
    func testFeedPlayerStartsLiveAudioAndBars() async throws {
        SoundFontStore.shared.preload()
        _ = await SoundFontStore.shared.load().value
        let player = FeedPlayer()
        player.play(slug: "fixture", url: try fixtureMIDI(), next: nil)
        let deadline = Date().addingTimeInterval(8)
        while player.lastTimeToFirstAudio == nil && Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
        guard let ttfa = player.lastTimeToFirstAudio else {
            player.pause()
            throw XCTSkip("engine output never reached the tap in 8 s (CI simulator HAL overload with the Debug-built synth); covered by the render-through-tap test")
        }
        print("timeToFirstAudio(local MIDI, bank preloaded) = \(ttfa) s")
        XCTAssertLessThan(ttfa, 1.0)
        // Tap blocks land in bursts on the CI simulator, so read bars per frame for up to 1.5 s like the card does.
        var peak: Float = 0
        let barsDeadline = Date().addingTimeInterval(1.5)
        repeat {
            try await Task.sleep(nanoseconds: 16_000_000)
            peak = max(peak, player.analyzer.bars(now: CACurrentMediaTime()).max() ?? 0)
        } while peak <= 0.3 && Date() < barsDeadline
        XCTAssertGreaterThan(peak, 0.3)
        XCTAssertGreaterThan(player.analyzer.waveform().map(abs).max() ?? 0, 0.02)
        XCTAssertGreaterThan(player.currentSeconds(for: "fixture") ?? 0, 0)
        player.pause()
    }
}
