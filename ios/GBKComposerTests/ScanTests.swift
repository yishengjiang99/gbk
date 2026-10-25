import SwiftUI
import UIKit
import XCTest
@testable import GBKComposer

/// Test-only recognizer: returns a fixed Score (or error) without touching the models.
struct FixtureSheetRecognizer: SheetRecognizer {
    var result: Result<Score, ScanError>
    func recognize(pages: [SheetPage]) async throws -> Score { try result.get() }

    static let twoParts = Score(parts: [
        ScorePart(name: "Treble", program: nil, notes: [ScoreNote(pitch: 72, onset: 1, duration: 1, velocity: 90),
                                                       ScoreNote(pitch: 60, onset: 0, duration: 0.5, velocity: 200)]),
        ScorePart(name: "Bass", program: 32, notes: [ScoreNote(pitch: 48, onset: 0, duration: 2, velocity: 64)]),
        ScorePart(name: "Empty", program: nil, notes: []),
    ], tempo: 100, key: "G", timeSig: TimeSignature(numerator: 3, denominator: 4))
}

final class ScoreOpsTests: XCTestCase {
    private let empty = StudioProjectInfo(ppq: 480, channels: [], noteCount: 0, readOnly: false)

    func testEmptyProjectGetsTempoKeyTimeSigAndOneTrackPerPart() throws {
        var n = 0
        let ops = try ScoreOps.ops(for: FixtureSheetRecognizer.twoParts, project: empty, newId: { n += 1; return "trk_\(n)" })
        XCTAssertEqual(ops, [
            .setTempoMap([.init(tick: 0, microPerQuarter: 600_000)]),
            .setTimeSigMap([.init(tick: 0, numerator: 3, denominator: 4)]),
            .setMeta(key: "G"),
            .addTrack(id: "trk_1", name: "Treble", channel: 0, program: 0),
            .addNotes([.init(trackId: "trk_1", channel: 0, tick: 0, duration: 240, pitch: 60, velocity: 127),
                       .init(trackId: "trk_1", channel: 0, tick: 480, duration: 480, pitch: 72, velocity: 90)]),
            .addTrack(id: "trk_2", name: "Bass", channel: 1, program: 32),
            .addNotes([.init(trackId: "trk_2", channel: 1, tick: 0, duration: 960, pitch: 48, velocity: 64)]),
        ])
    }

    func testExistingSongKeepsTempoAndSkipsUsedAndDrumChannels() throws {
        let project = StudioProjectInfo(ppq: 96, channels: [0, 1, 2, 3, 4, 5, 6, 7, 8], noteCount: 12, readOnly: false)
        let ops = try ScoreOps.ops(for: FixtureSheetRecognizer.twoParts, project: project, newId: { "t" })
        XCTAssertEqual(ops.count, 4)
        XCTAssertEqual(ops[0], .addTrack(id: "t", name: "Treble", channel: 10, program: 0))
        guard case .addNotes(let notes) = ops[1] else { return XCTFail() }
        XCTAssertEqual(notes.map(\.tick), [0, 96])
        XCTAssertEqual(ops[2], .addTrack(id: "t", name: "Bass", channel: 11, program: 32))
    }

    func testReadOnlyAndNothingRecognized() {
        XCTAssertThrowsError(try ScoreOps.ops(for: FixtureSheetRecognizer.twoParts,
                                              project: StudioProjectInfo(ppq: 480, channels: [], noteCount: 0, readOnly: true))) {
            XCTAssertEqual($0 as? ScanError, .readOnlyProject)
        }
        XCTAssertThrowsError(try ScoreOps.ops(for: Score(parts: []), project: empty)) { XCTAssertEqual($0 as? ScanError, .nothingRecognized) }
    }

    func testOpJSONMatchesWebOpShape() throws {
        let json = try ScoreOps.json([.addTrack(id: "trk_a", name: "Staff 1", channel: 2, program: 0),
                                      .addNotes([.init(trackId: "trk_a", channel: 2, tick: 0, duration: 480, pitch: 60, velocity: 80)])])
        XCTAssertEqual(json, #"[{"bankLsb":0,"bankMsb":0,"channel":2,"id":"trk_a","name":"Staff 1","op":"addTrack","program":0,"role":"melody"},"#
                       + #"{"notes":[{"channel":2,"duration":480,"pitch":60,"tick":0,"trackId":"trk_a","velocity":80}],"op":"addNotes"}]"#)
    }

    func testSMFReaderParsesNotesTempoKeyTimeSig() throws {
        // Type 1, 480 TPQ: conductor (tempo 120, 4/4, D major) + one track C4 quarter, E4 half (note-on vel 0 as off).
        func vlq(_ v: Int) -> [UInt8] { v < 128 ? [UInt8(v)] : [UInt8(0x80 | (v >> 7)), UInt8(v & 0x7f)] }
        func trk(_ ev: [UInt8]) -> [UInt8] { let e = ev + [0, 0xff, 0x2f, 0]; return Array("MTrk".utf8) + [0, 0, UInt8(e.count >> 8), UInt8(e.count & 0xff)] + e }
        let conductor = trk([0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20, 0, 0xff, 0x58, 4, 4, 2, 24, 8, 0, 0xff, 0x59, 2, 2, 0])
        let notes = trk([0, 0x90, 60, 100] + vlq(480) + [0x80, 60, 0, 0, 0x90, 64, 90] + vlq(960) + [64, 0])
        let smf = Array("MThd".utf8) + [0, 0, 0, 6, 0, 1, 0, 2, 0x01, 0xe0] + conductor + notes
        let s = try SMFReader.score(from: Data(smf))
        XCTAssertEqual(s.tempo, 120)
        XCTAssertEqual(s.timeSig, TimeSignature(numerator: 4, denominator: 4))
        XCTAssertEqual(s.key, "D")
        XCTAssertEqual(s.parts, [ScorePart(name: "Staff 1", program: nil, notes: [
            ScoreNote(pitch: 60, onset: 0, duration: 1, velocity: 100), ScoreNote(pitch: 64, onset: 1, duration: 2, velocity: 90)])])
    }
}

@MainActor
final class ScanBridgeTests: XCTestCase {
    func testStartMessageDecodesAndPresents() {
        let body: [String: Any] = ["type": "scan.start", "project": ["ppq": 480, "channels": [0, 9], "noteCount": 3, "readOnly": false]]
        let msg = ScanBridge.decode(body)
        XCTAssertEqual(msg, .init(type: "scan.start", project: StudioProjectInfo(ppq: 480, channels: [0, 9], noteCount: 3, readOnly: false)))
        let c = ScanController(recognizer: FixtureSheetRecognizer(result: .success(FixtureSheetRecognizer.twoParts)))
        c.handle(msg)
        XCTAssertTrue(c.isPresented)
        XCTAssertEqual(c.phase, .choose)
        XCTAssertNil(ScanBridge.decode(["type": 1]))
    }

    func testReadOnlyProjectShowsErrorImmediately() {
        let c = ScanController(recognizer: FixtureSheetRecognizer(result: .success(FixtureSheetRecognizer.twoParts)))
        c.handle(.init(type: "scan.start", project: StudioProjectInfo(ppq: 480, channels: [], noteCount: 0, readOnly: true, readOnlyReason: "shared")))
        XCTAssertEqual(c.phase, .error(.readOnlyProject))
    }

    func testScriptsCarryOpsAndCapabilityFlag() throws {
        XCTAssertTrue(ScanBridge.userScript.contains(#""scan""#) && ScanBridge.userScript.contains("scan: true"))
        let js = try ScanBridge.applyScript(ops: [.setMeta(key: "F")])
        XCTAssertTrue(js.contains(#"applyNativeOps([{"key":"F","op":"setMeta"}], {label: "scan sheet music", source: 'scan'})"#), js)
        XCTAssertEqual(ScanBridge.eventScript(status: "added", tracks: 2, notes: 9),
                       #"window.dispatchEvent(new CustomEvent('gbknative:scan', {detail: {"notes":9,"status":"added","tracks":2}}));"#)
    }

    func testNothingRecognizedSurfacesError() async throws {
        let c = ScanController(recognizer: FixtureSheetRecognizer(result: .failure(.nothingRecognized)))
        c.recognize([SheetPage(image: try XCTUnwrap(UIImage(systemName: "music.note")?.cgImage))])
        for _ in 0..<50 where c.phase == .working { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(c.phase, .error(.nothingRecognized))
    }
}

/// Real omr-homr-ios pipeline on a one-staff C major scale (omr-sheet-cam fixtures/mono.c_major_scale).
final class HomrRecognizerTests: XCTestCase {
    func testCMajorScaleFixtureProducesNotes() async throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "c_major_scale", withExtension: "png", subdirectory: "Fixtures"))
        let img = try XCTUnwrap(UIImage(contentsOfFile: url.path))
        let page = try XCTUnwrap(SheetPage(uiImage: img))
        let score: Score
        do { score = try await HomrSheetRecognizer().recognize(pages: [page]) }
        catch ScanError.recognizerUnavailable(let m) {
            if ProcessInfo.processInfo.environment["OMR_REQUIRE_MODELS"] == "1" { throw ScanError.recognizerUnavailable(m) }
            throw XCTSkip("OMR models not bundled: \(m)")
        }
        let pitches = score.parts.flatMap(\.notes).sorted { $0.onset < $1.onset }.map(\.pitch)
        XCTAssertEqual(pitches, [60, 62, 64, 65, 67, 69, 71, 72])
        let ops = try ScoreOps.ops(for: score, project: StudioProjectInfo(ppq: 480, channels: [], noteCount: 0, readOnly: false))
        XCTAssertTrue(ops.contains { if case .addTrack = $0 { return true }; return false })
    }
}
