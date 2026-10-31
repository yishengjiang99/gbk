import OMRHomrIOS
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
        for _ in 0..<1200 where c.phase == .working { try await Task.sleep(nanoseconds: 50_000_000) }
    }
    private func load(_ html: String) async throws -> WKWebView {
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        web.loadHTMLString(html, baseURL: URL(string: "https://compose.grepawk.com/"))
        // Wait until the WebContent process has actually parsed the page (listeners registered); on a loaded
        // CI runner a cold WebContent launch can take well over the old fixed 2.5 s.
        for _ in 0..<300 {
            if !web.isLoading, (try? await web.evaluateJavaScript("document.readyState")) as? String == "complete" { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
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

/// Thread-safe counter/log for `ScanWarmupTests` fake loaders. File scope (not nested in the
/// @MainActor test class) so its methods stay nonisolated — loaders call it from detached tasks.
private final class ScanWarmupBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _fractions: [Double] = []
    private var _runs = 0
    var fractions: [Double] { lock.lock(); defer { lock.unlock() }; return _fractions }
    var runs: Int { lock.lock(); defer { lock.unlock() }; return _runs }
    func append(_ f: Double) { lock.lock(); _fractions.append(f); lock.unlock() }
    func nextRun() -> Int { lock.lock(); _runs += 1; let r = _runs; lock.unlock(); return r }
}

/// Warmup parity with Music Reader: progress bus replay/reset, attach rules with a fake loader,
/// foreground kick, memory-warning release, ETA helpers, and the working view's copy. The real
/// loader (PageSessionCache load) is never invoked here.
@MainActor
final class ScanWarmupTests: XCTestCase {
    private enum FakeError: Error { case boom }

    func testProgressBusReplaysLastAndResets() {
        let bus = ScanWarmupProgressBus()
        let box = ScanWarmupBox()
        bus.broadcast(ScanWarmupProgress(fraction: 0.4, etaSeconds: 20))
        bus.add { p in box.append(p.fraction) }
        XCTAssertEqual(box.fractions, [0.4], "late attacher replays the current fraction at once")
        bus.broadcast(ScanWarmupProgress(fraction: 0.6, etaSeconds: 10))
        XCTAssertEqual(box.fractions, [0.4, 0.6])
        bus.reset()
        let box2 = ScanWarmupBox()
        bus.add { p in box2.append(p.fraction) }
        XCTAssertEqual(box2.fractions, [0], "a fresh run drops the stale fraction")
    }

    func testETAAndSmoothingHelpers() {
        XCTAssertEqual(ScanModelWarmup.etaSeconds(elapsedMs: 10_000, expectedTotalMs: 40_000), 30)
        XCTAssertEqual(ScanModelWarmup.etaSeconds(elapsedMs: 50_000, expectedTotalMs: 40_000), 0)
        XCTAssertEqual(ScanModelWarmup.smoothedExpectedTotal(previousMs: 0, newMs: 30_000), 30_000)
        XCTAssertEqual(ScanModelWarmup.smoothedExpectedTotal(previousMs: 40_000, newMs: 20_000), 34_000)
    }

    func testWorkingViewCopy() {
        XCTAssertEqual(ScanWorkingView.title(state: .warming(fraction: 0.427, etaSeconds: 21, isRewarm: false)), "Warming up… 42%")
        XCTAssertEqual(ScanWorkingView.title(state: .warming(fraction: 1.4, etaSeconds: nil, isRewarm: false)), "Warming up… 100%")
        XCTAssertEqual(ScanWorkingView.title(state: .reading), "Reading the sheet music…")
        XCTAssertEqual(ScanWorkingView.subtitle(state: .warming(fraction: 0.4, etaSeconds: 21.4, isRewarm: false)),
                       "About 21 seconds left · one-time setup")
        XCTAssertEqual(ScanWorkingView.subtitle(state: .warming(fraction: 0.4, etaSeconds: nil, isRewarm: false)),
                       "One-time setup — loading the music models on your iPhone")
        XCTAssertEqual(ScanWorkingView.subtitle(state: .warming(fraction: 0.4, etaSeconds: 12, isRewarm: true)),
                       "About 12 seconds left · reloading the music models")
        XCTAssertEqual(ScanWorkingView.subtitle(state: .warming(fraction: 0.4, etaSeconds: nil, isRewarm: true)),
                       "Reloading the music models on your iPhone")
        XCTAssertEqual(ScanWorkingView.subtitle(state: .reading), "This usually takes a few seconds")
    }

    func testAttachNeverStartsFirstEverWarmup() {
        let box = ScanWarmupBox()
        let w = ScanModelWarmup(loader: { _ in _ = box.nextRun() })
        XCTAssertFalse(w.attachProgressIfNeeded { _ in })
        XCTAssertEqual(w.state, .idle)
        XCTAssertEqual(box.runs, 0, "launch owns the first warmup; a scan must not start it")
    }

    func testAttachToReadyIsFalseAndReleasePreservesHasWarmedOnce() async {
        let box = ScanWarmupBox()
        let w = ScanModelWarmup(loader: { p in _ = box.nextRun(); p(0.5); p(1) })
        w.start()
        await w.waitUntilReady()
        XCTAssertEqual(w.state, .ready)
        XCTAssertTrue(w.hasWarmedOnce)
        XCTAssertFalse(w.attachProgressIfNeeded { _ in }, "already warm: no warmup phase")
        w.releaseModels()
        XCTAssertEqual(w.state, .idle)
        XCTAssertTrue(w.hasWarmedOnce, "memory-warning release preserves hasWarmedOnce (re-warm, not first warmup)")
    }

    func testAttachStartsRewarmAndBroadcastsFractions() async {
        let box = ScanWarmupBox()
        let w = ScanModelWarmup(loader: { p in _ = box.nextRun(); p(0.5); p(1) })
        w.start()
        await w.waitUntilReady()
        w.releaseModels()
        let seen = ScanWarmupBox()
        XCTAssertTrue(w.attachProgressIfNeeded { p in seen.append(p.fraction) })
        XCTAssertEqual(w.state, .warming)
        await w.waitUntilReady()
        XCTAssertEqual(w.state, .ready)
        XCTAssertEqual(box.runs, 2)
        XCTAssertTrue(seen.fractions.contains(0.5), "attached handler received the run's fractions: \(seen.fractions)")
    }

    func testFailedWarmupAttachRetries() async {
        let box = ScanWarmupBox()
        let w = ScanModelWarmup(loader: { _ in if box.nextRun() == 1 { throw FakeError.boom } })
        w.start()
        await w.waitUntilReady()
        guard case .failed = w.state else { return XCTFail("expected .failed, got \(w.state)") }
        XCTAssertTrue(w.attachProgressIfNeeded { _ in }, "a failed warmup is retried by attach")
        await w.waitUntilReady()
        XCTAssertEqual(w.state, .ready)
        XCTAssertEqual(box.runs, 2)
    }

    func testForegroundKickStartsOnceAndIsNoOpWhenReady() async {
        let box = ScanWarmupBox()
        let w = ScanModelWarmup(loader: { _ in _ = box.nextRun() })
        w.startOnForeground()
        XCTAssertEqual(w.state, .warming)
        w.startOnForeground() // already warming: no second run
        await w.waitUntilReady()
        XCTAssertEqual(w.state, .ready)
        w.startOnForeground() // ready: no-op
        XCTAssertEqual(box.runs, 1)
    }

    func testReleaseModelsIsNoOpWhileWarming() async {
        let w = ScanModelWarmup(loader: { _ in Thread.sleep(forTimeInterval: 0.3) })
        w.start()
        XCTAssertEqual(w.state, .warming)
        w.releaseModels()
        XCTAssertEqual(w.state, .warming, "a running warmup is never released from under a scan")
        await w.waitUntilReady()
        XCTAssertEqual(w.state, .ready)
    }

    /// End to end at the controller level: a scan during a re-warm shows the warming sub-state
    /// (isRewarm), retains the first page, then proceeds to reading + done once warm.
    func testScanAttachesToRewarmRetainsPageAndFinishes() async throws {
        let gate = DispatchSemaphore(value: 0)
        let box = ScanWarmupBox()
        let w = ScanModelWarmup(loader: { p in
            let run = box.nextRun()
            p(0.5)
            if run == 2 { gate.wait() } // hold the re-warm open until the test releases it
        })
        w.start()
        await w.waitUntilReady()
        XCTAssertEqual(w.state, .ready)
        w.releaseModels()

        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        web.loadHTMLString("""
        <html><body><script>
        window.addEventListener('gbk:midi-file', async function(e){ var f = e.detail.file; var b = new Uint8Array(await f.arrayBuffer());
          var d = document.createElement('div'); d.setAttribute('data-testid','midi-import'); d.textContent = f.name;
          document.body.appendChild(d); });
        </script></body></html>
        """, baseURL: URL(string: "https://compose.grepawk.com/"))
        for _ in 0..<300 {
            if !web.isLoading, (try? await web.evaluateJavaScript("document.readyState")) as? String == "complete" { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }

        let c = ScanController(recognizer: FixtureSheetRecognizer(result: .success(FixtureSheetRecognizer.twoParts)), warmup: w)
        c.webView = web
        let page = try XCTUnwrap(UIImage(systemName: "music.note")?.cgImage)
        c.recognize([SheetPage(image: page)])
        XCTAssertEqual(c.phase, .working)
        XCTAssertNotNil(c.scanningPage, "the first page is retained for the working view")
        // The attached handler hops to the main actor; poll until the 0.5 broadcast lands.
        for _ in 0..<200 {
            if case .warming(let f, _, let rewarm) = c.workingState, f == 0.5, rewarm { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        guard case .warming(let f, _, let rewarm) = c.workingState else {
            gate.signal()
            return XCTFail("expected the warming sub-state, got \(c.workingState)")
        }
        XCTAssertEqual(f, 0.5)
        XCTAssertTrue(rewarm, "post-release warmup is a re-warm")
        gate.signal()
        for _ in 0..<1200 where c.phase == .working { try await Task.sleep(nanoseconds: 50_000_000) }
        XCTAssertEqual(c.phase, .done(tracks: 2, notes: 3))
    }
}
