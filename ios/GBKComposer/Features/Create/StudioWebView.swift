import SwiftUI
import WebKit
import AVFoundation

/// Studio in a WKWebView. When signed in, tries the iOS-1 web-code handoff
/// (`POST /api/auth/web-code` → `/api/auth/web-code/redeem?return=/studio`); falls back to /studio on 404.
struct StudioWebView: View {
    static let studioURL = URL(string: "https://compose.grepawk.com/studio")!
    /// UI tests (`-uiTestHum`): a bundled page implementing the web side of the Hum bridge contract.
    static var humHarnessURL: URL? {
        ProcessInfo.processInfo.arguments.contains("-uiTestHum") ? Bundle.main.url(forResource: "hum-harness", withExtension: "html") : nil
    }
    @EnvironmentObject private var auth: AuthStore
    @State private var url: URL?
    @StateObject private var scan = ScanController()

    var body: some View {
        // Composer input must always be visible (keyboard up or down, during playback). Keyboard handling:
        // the web view is NOT `.ignoresSafeArea(.keyboard)`, so SwiftUI shrinks it to the area above the keyboard
        // (and above the tab bar when the keyboard is down). The page then sees a smaller viewport and pins its
        // shell to visualViewport (`--app-h`, src/midireader.tsx), keeping the bottom composer on screen.
        Group {
            if let url { WebView(url: url, scan: scan).accessibilityIdentifier("studio-webview") } else { ProgressView().tint(Theme.accent) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background.ignoresSafeArea())
        // Scan is started by the web (its Scan item, shown when window.gbkNative.scan) and runs in a sheet.
        .sheet(isPresented: $scan.isPresented) { ScanSheetView(controller: scan) }
        .task(id: auth.accessToken) {
            if let harness = Self.humHarnessURL { url = harness; return }
            let handoff = try? await AuthServices.current.webSessionURL(returnPath: "/studio")
            url = (handoff ?? nil) ?? Self.studioURL
        }
    }
}

struct WebView: UIViewRepresentable {
    let url: URL
    var scan: ScanController? = nil

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        HumBridge.install(on: config, bridge: context.coordinator.hum)
        // Must install on the configuration BEFORE the web view is created from it: WKWebView
        // snapshots the configuration at init, so the old post-creation call never registered
        // the gbkScan handler on the live web view.
        scan?.install(on: config)
        let midi = MIDIBridge.install(in: config) // Web MIDI polyfill backed by CoreMIDI (Core/MIDI, docs/ios/midi.md)
        let view = WKWebView(frame: .zero, configuration: config)
        context.coordinator.hum.webView = view
        scan?.webView = view
        midi.webView = view
        context.coordinator.midi = midi
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        context.coordinator.observeMicrophone(view)
        view.isOpaque = false
        view.backgroundColor = .clear
        // The page lays itself out to the visible viewport; don't let the scroll view add safe-area/keyboard
        // insets on top of the SwiftUI resize, or scroll a page that already fits (which pushes the composer off).
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.scrollView.bounces = false
        context.coordinator.pinWhenFitting(view.scrollView)
        Self.load(view, url)
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        if uiView.url == nil || context.coordinator.loaded != url {
            context.coordinator.loaded = url
            Self.load(uiView, url)
        }
    }

    static func load(_ view: WKWebView, _ url: URL) {
        if url.isFileURL { view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent()) }
        else { view.load(URLRequest(url: url)) }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var loaded: URL?
        let hum = HumBridge()
        var midi: MIDIBridge?
        private var offsetObservation: NSKeyValueObservation?
        private var micObservation: NSKeyValueObservation?

        // MARK: Studio "Hum" (gbk #109): mic → Basic Pitch in the page → "Hummed melody" track.

        /// Microphone capture is granted without a second WebKit prompt only for our own origin (the system
        /// NSMicrophoneUsageDescription prompt still appears once). Camera and other origins are denied.
        static func mediaCaptureDecision(host: String, type: WKMediaCaptureType) -> WKPermissionDecision {
            let ours = host == "compose.grepawk.com"
            return ours && type == .microphone ? .grant : .deny
        }

        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(Self.mediaCaptureDecision(host: origin.host, type: type))
        }

        /// While the page records, the app session is playAndRecord (speaker, Bluetooth, mixes with the SF2 studio
        /// playback); when capture ends it goes back to the feed's `.playback` session.
        func observeMicrophone(_ webView: WKWebView) {
            micObservation = webView.observe(\.microphoneCaptureState, options: [.new]) { wv, _ in
                let recording = wv.microphoneCaptureState != .none
                DispatchQueue.main.async { Self.setRecordingSession(recording) }
            }
        }

        static func setRecordingSession(_ recording: Bool) {
            let session = AVAudioSession.sharedInstance()
            if recording {
                try? session.setCategory(.playAndRecord, mode: .default,
                                         options: [.defaultToSpeaker, .allowBluetooth, .mixWithOthers])
                try? session.setActive(true)
            } else {
                FeedPlayer.configureAudioSession()
            }
        }

        /// Web alerts (e.g. "Microphone access was denied…", "Transcription failed…") need a native panel in WKWebView.
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            guard let top = Self.topController(webView) else { completionHandler(); return }
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            top.present(alert, animated: true)
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            guard let top = Self.topController(webView) else { completionHandler(false); return }
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
            top.present(alert, animated: true)
        }

        private static func topController(_ view: UIView) -> UIViewController? {
            var vc = view.window?.rootViewController
            while let p = vc?.presentedViewController { vc = p }
            return vc
        }

        /// WKWebView scrolls the focused field into view on keyboard show, even when the app shell already fits
        /// the (resized) viewport. That offset moves the bottom composer out of sight; reset it when nothing scrolls.
        func pinWhenFitting(_ scrollView: UIScrollView) {
            offsetObservation = scrollView.observe(\.contentOffset, options: [.new]) { sv, _ in
                guard Self.shouldReset(contentHeight: sv.contentSize.height, boundsHeight: sv.bounds.height,
                                       offsetY: sv.contentOffset.y) else { return }
                DispatchQueue.main.async { sv.setContentOffset(.zero, animated: false) }
            }
        }

        static func shouldReset(contentHeight: CGFloat, boundsHeight: CGFloat, offsetY: CGFloat) -> Bool {
            contentHeight <= boundsHeight + 1 && abs(offsetY) > 0.5
        }

        /// Web upgrade/buy links (/pricing, Stripe checkout) open the App Store paywall instead (guideline 3.1.1).
        static func isPurchaseLink(_ url: URL?) -> Bool {
            guard let url, let host = url.host?.lowercased() else { return false }
            if host.hasSuffix("stripe.com") { return true }
            let path = url.path.lowercased()
            return (host.hasSuffix("grepawk.com") && (path.hasPrefix("/pricing") || path.hasPrefix("/api/compose/checkout")))
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if Self.isPurchaseLink(action.request.url) {
                decisionHandler(.cancel)
                Task { @MainActor in PurchaseStore.shared.showPaywall = true }
            } else {
                decisionHandler(.allow)
            }
        }
    }
}
