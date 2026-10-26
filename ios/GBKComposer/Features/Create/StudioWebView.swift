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
    @Environment(\.requestSignIn) private var requestSignIn
    @State private var url: URL?
    /// UI tests (`-uiTestDark`): the app is locked to Light (Info.plist), so dark screenshots need an override.
    static var forcedScheme: ColorScheme? { ProcessInfo.processInfo.arguments.contains("-uiTestDark") ? .dark : nil }
    @StateObject private var scan = ScanController()

    var body: some View {
        // Composer input must always be visible (keyboard up or down, during playback). Keyboard handling:
        // the web view is NOT `.ignoresSafeArea(.keyboard)`, so SwiftUI shrinks it to the area above the keyboard
        // (and above the tab bar when the keyboard is down). The page then sees a smaller viewport and pins its
        // shell to visualViewport (`--app-h`, src/midireader.tsx), keeping the bottom composer on screen.
        // Native Scan entry: a slim bar ABOVE the web view (stacked, not overlaid), so it can never cover the
        // web toolbar or the bottom composer input.
        VStack(spacing: 0) {
            StudioNativeBar(onScan: { scan.start() }, onTestMIDI: { scan.loadTestMIDI() },
                            onTestFocus: { scan.webView?.evaluateJavaScript("window.dispatchEvent(new Event('gbk:focus-composer'))") },
                            onTestSignIn: { scan.webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('gbk:need-signin', {detail: {why: 'Sign in to publish and share your song.', pending: {kind: 'publish'}}}))") })
            Group {
                if let url {
                    WebView(url: url, scan: scan, onNeedSignIn: { why, kind in
                        guard WebView.nativeSignInKinds.contains(kind ?? "") else { return }
                        // Web keeps the pending action in sessionStorage; signing in changes the token, this view
                        // reloads through the web-code handoff and MobileStudio replays takePending("publish").
                        requestSignIn(why.isEmpty ? "Sign in to publish and share your song." : why, need: .linkedAccount)
                    }).accessibilityIdentifier("studio-webview")
                } else { ProgressView().tint(Theme.accent) }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Theme.background.ignoresSafeArea())
        .preferredColorScheme(Self.forcedScheme)
        .sheet(isPresented: $scan.isPresented) { ScanSheetView(controller: scan) }
        .task(id: auth.accessToken) {
            if let harness = Self.humHarnessURL { url = harness; return }
            let handoff = try? await AuthServices.current.webSessionURL(returnPath: "/studio")
            url = (handoff ?? nil) ?? Self.studioURL
        }
    }
}

/// Native controls for the studio, stacked above the web view. Scan only: the web compact-head (title, play pill,
/// ⋯) is the studio's header, so this bar carries no title or playback and stays one slim row.
struct StudioNativeBar: View {
    var onScan: () -> Void
    var onTestMIDI: () -> Void = {}
    var onTestFocus: () -> Void = {}
    var onTestSignIn: () -> Void = {}
    static let testMIDIEnabled = ProcessInfo.processInfo.arguments.contains("-uiTestStudioMIDI")
    var body: some View {
        HStack {
            if Self.testMIDIEnabled {
                Button("Load test MIDI", action: onTestMIDI).font(.caption).accessibilityIdentifier("load-test-midi")
                Button("Focus", action: onTestFocus).font(.caption).accessibilityIdentifier("test-focus-composer")
                Button("Need sign-in", action: onTestSignIn).font(.caption).accessibilityIdentifier("test-need-signin")
            }
            Spacer()
            Button(action: onScan) {
                Label("Scan sheet music", systemImage: "doc.viewfinder")
                    .font(.footnote.weight(.semibold))
                    .padding(.horizontal, 12).padding(.vertical, 5)
                    .foregroundStyle(Theme.onAccent)
                    .background(Theme.accent, in: Capsule())
            }
            .accessibilityIdentifier("scan-open")
        }
        .padding(.horizontal, 12).padding(.vertical, 4)
        .background(Theme.surface)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("studio-native-bar")
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 0.5) }
    }
}

struct WebView: UIViewRepresentable {
    let url: URL
    var scan: ScanController? = nil
    var onNeedSignIn: (@MainActor (_ why: String, _ kind: String?) -> Void)? = nil
    /// `gbk:need-signin` pending kinds that open the native Apple/Google sheet (publish needs a linked account).
    static let nativeSignInKinds: Set<String> = ["publish"]
    static let signInHandler = "signin"
    static let signInScript = """
    window.addEventListener("gbk:need-signin", function (e) { try {
      var d = e.detail || {}; window.webkit.messageHandlers.signin.postMessage({ why: String(d.why || ""), kind: d.pending && d.pending.kind || null });
    } catch (_) {} });
    """

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        HumBridge.install(on: config, bridge: context.coordinator.hum)
        config.userContentController.addUserScript(WKUserScript(source: Self.signInScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(SignInMessageHandler(context.coordinator), name: Self.signInHandler)
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
        context.coordinator.onNeedSignIn = onNeedSignIn
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
        var onNeedSignIn: (@MainActor (String, String?) -> Void)?
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

        /// While the page records, the app session is playAndRecord (speaker, Bluetooth; see AudioSessionController);
        /// when capture ends it goes back to `.playback`.
        func observeMicrophone(_ webView: WKWebView) {
            micObservation = webView.observe(\.microphoneCaptureState, options: [.new]) { wv, _ in
                let recording = wv.microphoneCaptureState != .none
                Task { @MainActor in Self.setRecordingSession(recording) }
            }
        }

        @MainActor static func setRecordingSession(_ recording: Bool) {
            let audio = AudioSessionController.shared
            if recording { try? audio.beginRecording("web-mic") } else { audio.endRecording("web-mic") }
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

/// Receives `gbk:need-signin` from our own origin (weak, so the content controller doesn't retain the coordinator).
final class SignInMessageHandler: NSObject, WKScriptMessageHandler {
    weak var coordinator: WebView.Coordinator?
    init(_ c: WebView.Coordinator) { coordinator = c }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard m.frameInfo.isMainFrame, HumBridge.isTrusted(m.frameInfo.securityOrigin),
              let body = m.body as? [String: Any] else { return }
        let why = body["why"] as? String ?? "", kind = body["kind"] as? String
        Task { @MainActor [weak self] in self?.coordinator?.onNeedSignIn?(why, kind) }
    }
}
