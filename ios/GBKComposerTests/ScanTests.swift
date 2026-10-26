import SwiftUI
import UIKit
import WebKit
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

final class SMFWriterTests: XCTestCase {
    func testScoreRoundTripsThroughSMF() throws {
        let score = FixtureSheetRecognizer.twoParts
        let back = try SMFReader.score(from: SMFWriter.data(for: score))
        XCTAssertEqual(back.tempo, 100)
        XCTAssertEqual(back.timeSig, TimeSignature(numerator: 3, denominator: 4))
        XCTAssertEqual(back.key, "G")
        XCTAssertEqual(back.parts.count, 2, "empty parts are dropped")
        XCTAssertEqual(back.parts[0].name, "Treble")
        XCTAssertEqual(back.parts[0].notes, [ScoreNote(pitch: 60, onset: 0, duration: 0.5, velocity: 127),
                                             ScoreNote(pitch: 72, onset: 1, duration: 1, velocity: 90)])
        XCTAssertEqual(back.parts[1].program, 32)
        XCTAssertEqual(back.parts[1].notes, [ScoreNote(pitch: 48, onset: 0, duration: 2, velocity: 64)])
    }

    func testRepeatedPitchRetriggersAndChannelsSkipDrums() throws {
        let s = Score(parts: [ScorePart(name: "P", program: nil, notes: [ScoreNote(pitch: 64, onset: 0, duration: 1, velocity: 80),
                                                                         ScoreNote(pitch: 64, onset: 1, duration: 1, velocity: 80)])])
        XCTAssertEqual(try SMFReader.score(from: SMFWriter.data(for: s)).parts[0].notes.count, 2)
        XCTAssertEqual((0..<11).map(SMFWriter.channel(for:)), [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11])
        XCTAssertEqual(SMFWriter.vlq(480), [0x83, 0x60])
        XCTAssertEqual(SMFWriter.keySignature("Ebm")?.sharps, -6)
    }

    func testSMFReaderParsesNotesTempoKeyTimeSig() throws {
        func vlq(_ v: Int) -> [UInt8] { v < 128 ? [UInt8(v)] : [UInt8(0x80 | (v >> 7)), UInt8(v & 0x7f)] }
        func trk(_ ev: [UInt8]) -> [UInt8] { let e = ev + [0, 0xff, 0x2f, 0]; return Array("MTrk".utf8) + [0, 0, UInt8(e.count >> 8), UInt8(e.count & 0xff)] + e }
        let conductor = trk([0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20, 0, 0xff, 0x58, 4, 4, 2, 24, 8, 0, 0xff, 0x59, 2, 2, 0])
        let notes = trk([0, 0x90, 60, 100] + vlq(480) + [0x80, 60, 0, 0, 0x90, 64, 90] + vlq(960) + [64, 0])
        let smf = Array("MThd".utf8) + [0, 0, 0, 6, 0, 1, 0, 2, 0x01, 0xe0] + conductor + notes
        let s = try SMFReader.score(from: Data(smf))
        XCTAssertEqual(s.tempo, 120)
        XCTAssertEqual(s.key, "D")
        XCTAssertEqual(s.parts.first?.notes, [ScoreNote(pitch: 60, onset: 0, duration: 1, velocity: 100), ScoreNote(pitch: 64, onset: 1, duration: 2, velocity: 90)])
    }
}

/// The hand-off uses only the studio's existing `gbk:midi-file` import event.
@MainActor
final class StudioMIDIImportTests: XCTestCase {
    private func pages() throws -> [SheetPage] { [SheetPage(image: try XCTUnwrap(UIImage(systemName: "music.note")?.cgImage))] }
    private func waitWhileWorking(_ c: ScanController) async throws {
        for _ in 0..<400 where c.phase == .working { try await Task.sleep(nanoseconds: 50_000_000) }
    }
    private func load(_ html: String) async throws -> WKWebView {
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        web.loadHTMLString(html, baseURL: URL(string: "https://compose.grepawk.com/"))
        for _ in 0..<50 where web.isLoading { try await Task.sleep(nanoseconds: 50_000_000) }
        try await Task.sleep(nanoseconds: 200_000_000)
        return web
    }

    func testDispatchesMidiFileEventAndFinishesWhenChooserShows() async throws {
        // Stand-in for prod's MidiImportChooser: listens for gbk:midi-file and renders data-testid="midi-import".
        let web = try await load("""
        <html><body><script>
        window.addEventListener('gbk:midi-file', async function(e){ var f = e.detail.file; var b = new Uint8Array(await f.arrayBuffer());
          var d = document.createElement('div'); d.setAttribute('data-testid','midi-import'); d.textContent = f.name + ' ' + f.type + ' ' + b.length + ' ' + String.fromCharCode(b[0],b[1],b[2],b[3]);
          document.body.appendChild(d); });
        </script></body></html>
        """)
        let c = ScanController(recognizer: FixtureSheetRecognizer(result: .success(FixtureSheetRecognizer.twoParts)))
        c.webView = web
        c.recognize(try pages())
        try await waitWhileWorking(c)
        XCTAssertEqual(c.phase, .done(tracks: 2, notes: 3))
        let text = try await web.evaluateJavaScript("document.querySelector('[data-testid=midi-import]').textContent") as? String
        XCTAssertEqual(text, "Scanned sheet music.mid audio/midi \(c.lastMIDI?.count ?? -1) MThd")
    }

    func testStudioWithoutImportShowsNotReady() async throws {
        let c = ScanController(recognizer: FixtureSheetRecognizer(result: .success(FixtureSheetRecognizer.twoParts)))
        c.webView = try await load("<html><body>no studio</body></html>")
        c.recognize(try pages())
        try await waitWhileWorking(c)
        XCTAssertEqual(c.phase, .error(.studioNotReady))
    }

    func testNothingRecognizedSurfacesError() async throws {
        let c = ScanController(recognizer: FixtureSheetRecognizer(result: .failure(.nothingRecognized)))
        c.recognize(try pages())
        try await waitWhileWorking(c)
        XCTAssertEqual(c.phase, .error(.nothingRecognized))
    }

    func testNoScanCapabilityFlag() {
        XCTAssertFalse(HumBridge.capabilityScript.contains("scan"))
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
        XCTAssertFalse(SMFWriter.data(for: score).isEmpty)
    }
}
