import OMRScanKit
import OMRScanUI
import SwiftUI
import UIKit
import WebKit
import XCTest
@testable import GBKComposer

/// Test recognizer: a fixed outcome per page, no models.
private struct FixtureRecognizer: RecognitionService {
    var outcome: RecognitionOutcome
    func recognize(imageData: Data) async -> RecognitionOutcome { outcome }

    /// One treble + one bass staff (a minimal two-track SMF), 3 notes.
    static func twoTrack() -> RecognitionOutcome {
        var trk: [UInt8] = [0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20, 0x00, 0xC0, 0x00]
        for p: UInt8 in [60, 62] { trk += [0x00, 0x90, p, 0x60, 0x83, 0x60, 0x80, p, 0x00] }
        trk += [0x00, 0xFF, 0x2F, 0x00]
        let n = trk.count
        let smf = Data(Array("MThd".utf8) + [0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xE0] + Array("MTrk".utf8)
                       + [0, 0, UInt8(n >> 8), UInt8(n & 0xFF)] + trk)
        return .recognized(RecognitionDetails(midi: smf, notes: [], staffCount: 1, warnings: [], layoutSource: "midi-fallback", ms: 1))
    }
}

/// The hand-off uses only the studio's existing `gbk:midi-file` import event.
@MainActor
final class StudioMIDIImportTests: XCTestCase {
    private func page() throws -> Data { try XCTUnwrap(UIImage(systemName: "music.note")?.pngData()) }
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
        let c = ScanCoordinator(runner: ScanRunner(service: FixtureRecognizer(outcome: FixtureRecognizer.twoTrack())))
        c.webView = web
        let result = try await c.runner.run(pages: [try page()], source: .fixture, host: GBKScanHost(coordinator: c))
        XCTAssertEqual(result.trackCount, 1)
        XCTAssertEqual(result.noteCount, 2)
        let text = try await web.evaluateJavaScript("document.querySelector('[data-testid=midi-import]').textContent") as? String
        XCTAssertEqual(text, "Scanned sheet music.mid audio/midi \(c.lastMIDI?.count ?? -1) MThd")
    }

    func testStudioWithoutImportShowsNotReady() async throws {
        let c = ScanCoordinator(runner: ScanRunner(service: FixtureRecognizer(outcome: FixtureRecognizer.twoTrack())))
        c.webView = try await load("<html><body>no studio</body></html>")
        do {
            _ = try await c.runner.run(pages: [try page()], host: GBKScanHost(coordinator: c))
            XCTFail("expected the hand-off to fail")
        } catch let e as ScanError {
            XCTAssertEqual(e.kind, .handOffFailed)
            XCTAssertEqual(e.reasonCode, "studio_not_ready")
            XCTAssertEqual(e.message, StudioNotReady().scanMessage)
        }
    }

    func testNothingRecognizedSurfacesClassifiedError() async throws {
        let c = ScanCoordinator(runner: ScanRunner(service: FixtureRecognizer(outcome: .failed("no notes recognized (1 staff)"))))
        do {
            _ = try await c.runner.run(pages: [try page()], host: GBKScanHost(coordinator: c))
            XCTFail("expected failure")
        } catch let e as ScanError {
            XCTAssertEqual(e.kind, .nothingRecognized)
            XCTAssertEqual(e.reasonCode, "no_notes")
        }
    }

    func testCancelledScanNeverReachesTheStudio() async throws {
        let c = ScanCoordinator(runner: ScanRunner(service: FixtureRecognizer(outcome: FixtureRecognizer.twoTrack())))
        c.webView = try await load("<html><body></body></html>")
        let data = try page()
        let task = Task { try await c.runner.run(pages: [data], host: GBKScanHost(coordinator: c)) }
        task.cancel()
        _ = try? await task.value
        XCTAssertNil(c.lastMIDI, "a cancelled scan must not hand a late result to the studio")
    }

    func testNoScanCapabilityFlag() {
        XCTAssertFalse(HumBridge.capabilityScript.contains("scan"))
    }
}

/// Real omr-homr-ios pipeline on a one-staff C major scale (omr-sheet-cam fixtures/mono.c_major_scale),
/// through the shared ScanRunner exactly as the Scan sheet drives it.
final class HomrRecognizerTests: XCTestCase {
    func testCMajorScaleFixtureProducesNotes() async throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "c_major_scale", withExtension: "png", subdirectory: "Fixtures"))
        let data = try Data(contentsOf: url)
        let result: ScanResult
        do { result = try await ScanRunner().run(pages: [data], source: .fixture) }
        catch let e as ScanError where e.kind == .recognizerUnavailable {
            if ProcessInfo.processInfo.environment["OMR_REQUIRE_MODELS"] == "1" { throw e }
            throw XCTSkip("OMR models not bundled: \(e.message)")
        }
        let pitches = result.pages.flatMap(\.notes).sorted { $0.onsetTicks < $1.onsetTicks }.compactMap(\.midiNote)
        XCTAssertEqual(pitches, [60, 62, 64, 65, 67, 69, 71, 72])
        XCTAssertFalse(result.midi.isEmpty)
    }
}
