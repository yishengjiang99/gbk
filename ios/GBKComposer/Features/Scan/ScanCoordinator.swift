import OMRScanKit
import OMRScanUI
import SwiftUI
import WebKit

/// Hands a recognized score to the studio through its existing MIDI import (live since befdd00):
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

/// The studio could not take the import (web view missing, page without the import chooser).
struct StudioNotReady: ScanFailureReporting {
    var scanReasonCode: String { "studio_not_ready" }
    var scanMessage: String { "The studio isn't ready to import yet. Wait for it to finish loading, then try again." }
}

/// Owns the native Scan sheet and the hand-off to the studio web view. Recognition, progress,
/// cancellation and the sheet UI live in OMRScanKit / OMRScanUI; this is only the studio glue.
@MainActor
final class ScanCoordinator: ObservableObject {
    @Published var isPresented = false
    weak var webView: WKWebView?
    let runner: ScanRunner
    let telemetry: ScanTelemetryLogger
    /// Last SMF handed to the studio (tests).
    private(set) var lastMIDI: Data?

    init(runner: ScanRunner = ScanRunner(), telemetry: ScanTelemetryLogger? = nil) {
        self.runner = runner
        // Resolved inside the @MainActor init so nonisolated call sites (SwiftUI views) never
        // touch the main-actor singleton in a default-argument expression.
        self.telemetry = telemetry ?? .shared
    }

    func start() { isPresented = true }

    /// Studio import: dispatch the file event, then wait for the chooser to render.
    func handOff(_ midi: Data) async throws {
        lastMIDI = midi
        guard let webView else { throw StudioNotReady() }
        let r = try? await webView.evaluateJavaScript(StudioMIDIImport.script(midi: midi)) as? String
        guard r == "dispatched" else { throw StudioNotReady() }
        for _ in 0..<20 { // the chooser renders on the next React commit
            if (try? await webView.evaluateJavaScript(StudioMIDIImport.chooserVisibleScript)) as? Bool == true { return }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        throw StudioNotReady()
    }

    /// UI tests (`-uiTestStudioMIDI`): hands a tiny C-major scale SMF to the studio without the 3-minute OMR run.
    func loadTestMIDI() { Task { try? await handOff(Self.testSMF) } }

    nonisolated static var testSMF: Data {
        var trk: [UInt8] = [0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20, 0x00, 0xC0, 0x00] // 120 bpm, piano
        for p: UInt8 in [60, 62, 64, 65, 67, 69, 71, 72] { trk += [0x00, 0x90, p, 0x60, 0x83, 0x60, 0x80, p, 0x00] }
        trk += [0x00, 0xFF, 0x2F, 0x00]
        let n = UInt32(trk.count)
        let len: [UInt8] = [UInt8(n >> 24), UInt8(n >> 16 & 0xFF), UInt8(n >> 8 & 0xFF), UInt8(n & 0xFF)]
        return Data([0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xE0, 0x4D, 0x54, 0x72, 0x6B] + len + trk)
    }
}

extension ScanTheme {
    /// GBK's tokens (dynamic asset-catalog colors). The reading card keeps ScanTheme's explicit
    /// white-on-near-black because the app is locked to Light (Info.plist).
    static var gbk: ScanTheme {
        ScanTheme(accent: Theme.accent, sheetBackground: AnyShapeStyle(Theme.background), sheetText: Theme.text,
                  sheetSecondaryText: Theme.textSecondary, sheetSurface: Theme.surfaceRaised,
                  sheetBorder: Theme.border, destructive: Theme.destructive)
    }
}

/// The Scan sheet: OMRScanFlow with GBK's host, theme and (UI tests only) the fixture page.
struct ScanSheet: View {
    static var fixtureEnabled: Bool { ProcessInfo.processInfo.arguments.contains("-uiTestScanFixture") }
    @ObservedObject var coordinator: ScanCoordinator

    var body: some View {
        OMRScanFlow(host: GBKScanHost(coordinator: coordinator), runner: coordinator.runner, fixture: fixture) { _ in
            coordinator.isPresented = false
        }
        .scanTheme(.gbk)
    }

    /// UI tests (`-uiTestScanFixture`): the simulator has no document camera.
    private var fixture: ScanFixture? {
        guard Self.fixtureEnabled, let url = Bundle.main.url(forResource: "scan-fixture", withExtension: "png") else { return nil }
        return ScanFixture { UIImage(contentsOfFile: url.path) }
    }
}
