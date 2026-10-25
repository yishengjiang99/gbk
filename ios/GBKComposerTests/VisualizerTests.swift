import XCTest
@testable import GBKComposer

final class PianoRollMathTests: XCTestCase {
    // Preview units: [track, start 0...1000, len 0...1000, pitch]; 40 s song.
    let preview = SongPreview(tracks: ["#4fc3f7", "#ffb74d"], lo: 60, hi: 72, end: 61440, duration: nil,
                              notes: [[0, 0, 100, 60], [1, 500, 10, 72], [0, 990, 10, 61]])

    func testConstantsMatchWeb() {
        XCTAssertEqual(FeedVisuals.playheadFraction, 0.25)
        XCTAssertEqual(FeedVisuals.windowSeconds, 4)
        XCTAssertEqual(FeedVisuals.barCount, 48)
        XCTAssertEqual(FeedVisuals.decaySeconds, 0.15)
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
        let w = PianoRollMath.window(notes: notes, time: 2, lo: 60, hi: 72, durationSeconds: 40)
        XCTAssertEqual(w.count, 1)
        XCTAssertTrue(w[0].isActive)
        XCTAssertEqual(w[0].x0, -0.25, accuracy: 1e-9)  // started 2 s ago = half the 1 s left margin past the edge
        XCTAssertEqual(w[0].x1, 0.75, accuracy: 1e-9)   // ends 2 s after the playhead
        XCTAssertLessThan(w[0].x0, FeedVisuals.playheadFraction)
        XCTAssertGreaterThan(w[0].x1, FeedVisuals.playheadFraction)
    }

    func testPastNotesDisappearAndUpcomingAreInactive() {
        let notes = PianoRollMath.notes(from: preview, durationSeconds: 40)
        XCTAssertTrue(PianoRollMath.window(notes: notes, time: 4.5, lo: 60, hi: 72, durationSeconds: 40).isEmpty)
        let up = PianoRollMath.window(notes: notes, time: 18, lo: 60, hi: 72, durationSeconds: 40)
        XCTAssertEqual(up.map(\.note.pitch), [72])
        XCTAssertFalse(up[0].isActive)
        XCTAssertEqual(up[0].x0, 0.75, accuracy: 1e-9) // 2 s ahead → 0.25 + 2/4
    }

    func testLoopWrapShowsStartOfSongAhead() {
        let notes = PianoRollMath.notes(from: preview, durationSeconds: 40)
        let w = PianoRollMath.window(notes: notes, time: 38, lo: 60, hi: 72, durationSeconds: 40)
        XCTAssertEqual(Set(w.map(\.note.pitch)), [60, 61])
        XCTAssertEqual(w.first { $0.note.pitch == 60 }!.x0, 0.75, accuracy: 1e-9)
    }

    func testPitchRowsCentredWithMinimumSpan() {
        let notes = [RollNote(track: 0, start: 0, length: 1, pitch: 64)]
        let w = PianoRollMath.window(notes: notes, time: 0.5, lo: 64, hi: 64)
        // span = max(12, 1) → row height 1/12, centred: offset 11/24
        XCTAssertEqual(w[0].yTop, 11.0 / 24.0, accuracy: 1e-9)
        XCTAssertEqual(w[0].height, 0.85 / 12, accuracy: 1e-9)
    }
}

final class SpectrumTests: XCTestCase {
    func testLogBandsCoverRangeContiguously() {
        for rate in [44_100.0, 48_000.0] {
            let bands = SpectrumMath.logBands(fftSize: 2048, sampleRate: rate)
            XCTAssertEqual(bands.count, 48)
            XCTAssertEqual(bands.first?.lowerBound, 1, "DC bin is skipped")
            XCTAssertTrue(bands.allSatisfy { !$0.isEmpty })
            XCTAssertTrue(zip(bands, bands.dropFirst()).allSatisfy { $0.upperBound == $1.lowerBound })
            let hzPerBin = rate / 2048
            XCTAssertEqual(Double(bands.last!.upperBound) * hzPerBin, 16_000, accuracy: hzPerBin)
            // log spacing: upper bands are wider than lower ones
            XCTAssertGreaterThan(bands.last!.count, bands[24].count)
            XCTAssertGreaterThanOrEqual(bands[24].count, bands[0].count)
        }
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
        let down = SpectrumMath.smooth(previous: [1], target: [0], dt: 0.15)
        XCTAssertEqual(down[0], Float(exp(-1.0)), accuracy: 1e-6)
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

    func testWaveformDownsampleKeepsPeaks() {
        XCTAssertEqual(WaveformMath.points([0, 0.5, -0.9, 0.1], count: 2), [0.5, -0.9])
        XCTAssertEqual(WaveformMath.points([], count: 3), [0, 0, 0])
    }
}
