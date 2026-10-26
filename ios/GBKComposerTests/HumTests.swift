import XCTest
@testable import GBKComposer
import HearSheetCore

/// Parity with web test/hum.test.ts (notes-to-ops) and earsheet's decoder tests (vendored HearSheetCore).
final class HumNotesToOpsTests: XCTestCase {
    @MainActor func testBridgeCommandsAndCapabilities() {
        XCTAssertEqual(HumBridge.command(["type": "toggle"]), .toggle)
        XCTAssertEqual(HumBridge.command(["type": "cancel"]), .cancel)
        XCTAssertNil(HumBridge.command(["type": "scan"]))
        XCTAssertNil(HumBridge.command("cancel"))
        XCTAssertTrue(HumBridge.capabilityScript.contains(#"["hum", "midi"]"#))
        XCTAssertFalse(HumBridge.capabilityScript.contains("scan"), "Scan stays native-only")
    }

    func testVelocityMapsLikeWeb() {
        XCTAssertEqual(HumNotesToOps.amplitudeToVelocity(1), 127)
        XCTAssertEqual(HumNotesToOps.amplitudeToVelocity(0), 1)
        XCTAssertEqual(HumNotesToOps.amplitudeToVelocity(0.5), 64)
        XCTAssertEqual(HumNotesToOps.amplitudeToVelocity(nil), 102)
        XCTAssertEqual(HumNotesToOps.amplitudeToVelocity(.nan), 102)
    }

    func testSecondsMapThroughTempoMap() {
        let p = HumProjectContext() // 480 ppq, 120 bpm
        let ops = HumNotesToOps.ops(project: p, notes: [HumTimedNote(pitchMidi: 60, startSec: 0.5, endSec: 1.0, amplitude: 0.5)], trackId: "trk_hum")
        XCTAssertEqual(ops.count, 2)
        XCTAssertEqual(ops[0], .addTrack(id: "trk_hum", name: "Hummed melody", channel: 0, program: 0))
        XCTAssertEqual(ops[1], .addNotes([HumNote(trackId: "trk_hum", channel: 0, tick: 480, duration: 480, pitch: 60, velocity: 64)]))
        var slow = HumProjectContext(); slow.tempos = [HumTempo(tick: 0, microPerQuarter: 1_000_000)]
        let ops2 = HumNotesToOps.ops(project: slow, notes: [HumTimedNote(pitchMidi: 62, startSec: 0.5, endSec: 0.75, amplitude: 1)], trackId: "t2")
        guard case .addNotes(let n2) = ops2[1] else { return XCTFail() }
        XCTAssertEqual(n2[0].tick, 240)
        XCTAssertEqual(n2[0].duration, 120)
    }

    func testThreeNoteTakeSortsAndEndsAt1440() {
        let notes = [HumTimedNote(pitchMidi: 67, startSec: 1.0, endSec: 1.5, amplitude: 0.8),
                     HumTimedNote(pitchMidi: 60, startSec: 0, endSec: 0.5, amplitude: 0.9),
                     HumTimedNote(pitchMidi: 64, startSec: 0.5, endSec: 1.0, amplitude: 0.7)]
        guard case .addNotes(let n) = HumNotesToOps.ops(project: HumProjectContext(), notes: notes, trackId: "h")[1] else { return XCTFail() }
        XCTAssertEqual(n.map(\.pitch), [60, 64, 67])
        XCTAssertEqual(n.map { $0.tick + $0.duration }.max(), 1440)
    }

    func testChannelSkipsUsedAndDrums() {
        XCTAssertEqual(HumNotesToOps.nextMelodicChannel([]), 0)
        XCTAssertEqual(HumNotesToOps.nextMelodicChannel([0, 1]), 2)
        XCTAssertEqual(HumNotesToOps.nextMelodicChannel(Array(0...8)), 10)
    }

    func testTempoChangeMidSong() {
        var p = HumProjectContext()
        p.tempos = [HumTempo(tick: 0, microPerQuarter: 500_000), HumTempo(tick: 960, microPerQuarter: 1_000_000)]
        // 1 s at 120 bpm = 960 ticks; then 60 bpm: +0.5 s = 240 ticks
        XCTAssertEqual(HumNotesToOps.secToTick(p, 1.5), 1200)
    }

    func testNoNotesNoOpsAndOpJSONShape() {
        XCTAssertTrue(HumNotesToOps.ops(project: HumProjectContext(), notes: [], trackId: "x").isEmpty)
        let j = HumOp.addTrack(id: "t", name: "Hummed melody", channel: 2, program: 0).json
        XCTAssertEqual(j["op"] as? String, "addTrack")
        XCTAssertEqual(j["role"] as? String, "melody")
        XCTAssertEqual(j["bankMsb"] as? Int, 0)
        XCTAssertTrue(HumNotesToOps.newTrackId().hasPrefix("trk_"))
    }

    func testContextParsing() {
        let c = HumBridge.parseContext(["ppq": 960, "tempos": [["tick": 0, "microPerQuarter": 600_000]],
                                        "tracks": [["channel": 0], ["channel": 3]], "readOnlyReason": "shared song"])
        XCTAssertEqual(c.ppq, 960)
        XCTAssertEqual(c.tempos, [HumTempo(tick: 0, microPerQuarter: 600_000)])
        XCTAssertEqual(c.trackChannels, [0, 3])
        XCTAssertEqual(c.readOnlyReason, "shared song")
        XCTAssertEqual(HumBridge.parseContext([:]), HumProjectContext())
    }

    func testResampleTo22050() {
        let x = [Float](repeating: 0.5, count: 48_000)
        let y = HumRecorder.resample(x, from: 48_000)
        XCTAssertEqual(y.count, 22_050)
        XCTAssertEqual(y[10_000], 0.5, accuracy: 1e-4)
    }

    func testNoteEventMapsToWebTimedNote() {
        let t = HumTranscriber.timed(NoteEvent(onset: 0.5, offset: 1, midi: 64, velocity: 64))
        XCTAssertEqual(t, HumTimedNote(pitchMidi: 64, startSec: 0.5, endSec: 1, amplitude: 64.0 / 127))
        XCTAssertEqual(HumNotesToOps.amplitudeToVelocity(t.amplitude), 64)
    }
}

/// earsheet ModelThresholdsTests.testDecoderUsesGivenOnsetFrameAndMinLength, vendored.
final class HumDecoderTests: XCTestCase {
    private typealias T = BasicPitchDecoder.Thresholds

    private func posteriors(length: Int) -> ([[Float]], [[Float]], [[Float]]) {
        let n = 200
        var note = [[Float]](repeating: [Float](repeating: 0.01, count: 88), count: n)
        var onset = note
        let contour = [[Float]](repeating: [Float](repeating: 0.01, count: 264), count: n)
        let f = 69 - 21 // BasicPitchDecoder.midiOffset (A0)
        for t in 20..<(20 + length) { note[t][f] = 0.35 }
        onset[20][f] = 0.6
        return (note, onset, contour)
    }

    func testDecoderUsesGivenOnsetFrameAndMinLength() {
        let (note, onset, contour) = posteriors(length: 8)
        func decode(_ t: T) -> [BasicPitchDecoder.RawNote] {
            BasicPitchDecoder.decode(frames: note, onset: onset, contour: contour, thresholds: t)
        }
        let viaOnset = decode(T(onset: 0.5, frame: 0.3, minNoteLenFrames: 5))
        XCTAssertEqual(viaOnset.map(\.midi), [69])
        XCTAssertEqual(viaOnset.first?.startFrame, 20)
        XCTAssertEqual(viaOnset.first?.endFrame, 28)
        XCTAssertTrue(decode(T(onset: 0.5, frame: 0.4, minNoteLenFrames: 5)).isEmpty)
        XCTAssertTrue(decode(T(onset: 0.5, frame: 0.3, minNoteLenFrames: 11)).isEmpty)
    }

    func testSilenceDecodesToNothing() {
        let z = [[Float]](repeating: [Float](repeating: 0, count: 88), count: 50)
        XCTAssertTrue(BasicPitchDecoder.decode(frames: z, onset: z, contour: [[Float]](repeating: [Float](repeating: 0, count: 264), count: 50),
                                               thresholds: .basicPitchDefaults).isEmpty)
    }

    /// End to end on the simulator: bundled Core ML model + fixture (C4 E4 G4 C5 hum-like tones).
    func testBundledModelTranscribesFixture() async throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "hum-fixture", withExtension: "wav"))
        let samples = try HumRecorder.load(url: url)
        let notes = try await HumTranscriber.transcribe(samples)
        let pitches = notes.map { Int($0.pitchMidi) }
        XCTAssertFalse(pitches.isEmpty)
        for p in [60, 64, 67, 72] { XCTAssertTrue(pitches.contains(p), "missing \(p) in \(pitches)") }
    }
}
