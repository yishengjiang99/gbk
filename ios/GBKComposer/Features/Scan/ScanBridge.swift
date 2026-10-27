import Foundation
import WebKit

/// Hands a recognized Score to the studio through its existing MIDI import (live since befdd00):
/// the page's MidiImportChooser listens for `window` event `gbk:midi-file` with `{detail: {file}}` and asks the
/// user "Open as new project" / "Add to current project" (read-only projects open as a new project).
/// No web change is needed; nothing here depends on a native-specific web API.
enum StudioMIDIImport {
    static let fileName = "Scanned sheet music.mid"

    static func script(midi: Data, fileName: String = fileName) -> String {
        """
        (function(){ try {
          var b = atob("\(midi.base64EncodedString())"), u = new Uint8Array(b.length);
          for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
          var f = new File([u], \(jsString(fileName)), {type: "audio/midi"});
          window.dispatchEvent(new CustomEvent("gbk:midi-file", {detail: {file: f}}));
          return "dispatched";
        } catch (e) { return "error:" + (e && e.message || e); } })()
        """
    }

    /// True once the page shows its import chooser (data-testid="midi-import").
    static let chooserVisibleScript = "!!document.querySelector('[data-testid=\"midi-import\"]')"

    static func jsString(_ s: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
        return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
    }
}

/// Owns the native Scan sheet and the hand-off to the studio web view.
@MainActor
final class ScanController: ObservableObject {
    enum Phase: Equatable { case choose, working, error(ScanError), done(tracks: Int, notes: Int) }

    @Published var isPresented = false
    @Published var phase: Phase = .choose
    weak var webView: WKWebView?
    let recognizer: SheetRecognizer
    /// Last SMF handed to the studio (tests).
    private(set) var lastMIDI: Data?

    init(recognizer: SheetRecognizer = HomrSheetRecognizer()) { self.recognizer = recognizer }

    func start() { phase = .choose; isPresented = true }
    func fail(_ e: ScanError) { phase = .error(e) }

    func recognize(_ pages: [SheetPage]) {
        guard !pages.isEmpty else { return }
        phase = .working
        Task {
            do {
                let score = try await recognizer.recognize(pages: pages)
                guard score.noteCount > 0 else { throw ScanError.nothingRecognized }
                let midi = SMFWriter.data(for: score)
                lastMIDI = midi
                try await handOff(midi)
                let tracks = score.parts.filter { !$0.notes.isEmpty }.count
                phase = .done(tracks: tracks, notes: score.noteCount)
                try? await Task.sleep(nanoseconds: 700_000_000)
                if case .done = phase { isPresented = false } // the studio's import chooser is now on screen
            } catch let e as ScanError {
                phase = .error(e)
            } catch {
                phase = .error(.failed(error.localizedDescription))
            }
        }
    }

    private func handOff(_ midi: Data, fileName: String = StudioMIDIImport.fileName) async throws {
        guard let webView else { throw ScanError.studioNotReady }
        let r = try? await webView.evaluateJavaScript(StudioMIDIImport.script(midi: midi, fileName: fileName)) as? String
        guard r == "dispatched" else { throw ScanError.studioNotReady }
        for _ in 0..<20 { // the chooser renders on the next React commit
            if (try? await webView.evaluateJavaScript(StudioMIDIImport.chooserVisibleScript)) as? Bool == true { return }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        throw ScanError.studioNotReady
    }

    func cancel() { isPresented = false }

    /// UI tests (`-uiTestStudioMIDI`): hands a tiny C-major scale SMF to the studio without the 3-minute OMR run.
    /// `-uiTestMIDIName <name.mid>` gives the imported project a unique title (no clash with songs other tests published).
    func loadTestMIDI() {
        let args = ProcessInfo.processInfo.arguments
        let name = args.firstIndex(of: "-uiTestMIDIName").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } ?? StudioMIDIImport.fileName
        Task { try? await handOff(Self.testSMF, fileName: name) }
    }

    nonisolated static var testSMF: Data {
        var trk: [UInt8] = [0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20, 0x00, 0xC0, 0x00] // 120 bpm, piano
        for p: UInt8 in [60, 62, 64, 65, 67, 69, 71, 72] { trk += [0x00, 0x90, p, 0x60, 0x83, 0x60, 0x80, p, 0x00] }
        trk += [0x00, 0xFF, 0x2F, 0x00]
        let n = UInt32(trk.count)
        let len: [UInt8] = [UInt8(n >> 24), UInt8(n >> 16 & 0xFF), UInt8(n >> 8 & 0xFF), UInt8(n & 0xFF)]
        return Data([0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xE0, 0x4D, 0x54, 0x72, 0x6B] + len + trk)
    }
}
