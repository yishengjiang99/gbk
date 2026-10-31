import SwiftUI
import WebKit
import AVFoundation

/// Studio in a WKWebView. When signed in, tries the iOS-1 web-code handoff
/// (`POST /api/auth/web-code` → `/api/auth/web-code/redeem?return=/studio`); falls back to /studio on 404.
struct StudioWebView: View {
    static let studioURL = URL(string: "https://compose.grepawk.com/studio")!
    /// Yisheng: start a new project only when there is no work-in-progress draft. The studio restores the latest
    /// project; after each load and on every entry to Create, `freshNeeded` decides, and only then do we do a full
    /// load of `/studio?new=<n>` (the web skips the restore; earlier projects stay saved).
    static func studioPath(fresh: Bool) -> String { fresh ? "/studio?new=\(Int(Date().timeIntervalSince1970 * 1000))" : "/studio" }
    /// UI tests (`-uiTestHum`): a bundled page implementing the web side of the Hum bridge contract.
    static var humHarnessURL: URL? {
        ProcessInfo.processInfo.arguments.contains("-uiTestHum") ? Bundle.main.url(forResource: "hum-harness", withExtension: "html") : nil
    }
    @EnvironmentObject private var auth: AuthStore
    @EnvironmentObject private var router: DeepLinkRouter
    @State private var url: URL?
    /// Access token `url` was built for. `.task` restarts on every re-appear (each tab switch back to Create); only a
    /// token change (sign-in / guest session) may rebuild the URL, otherwise the WKWebView reloads and drops the draft.
    @State private var urlToken: String?
    /// UI tests (`-uiTestDark`): the app is locked to Light (Info.plist), so dark screenshots need an override.
    static var forcedScheme: ColorScheme? { ProcessInfo.processInfo.arguments.contains("-uiTestDark") ? .dark : nil }
    @StateObject private var scan = ScanController()
    @State private var publishRequest: PublishBridge.Request?
    @State private var published = false
    /// Feed-card requests waiting on the Studio page: a remix (song slug + prompt) to hand
    /// to the composer and a song to open, both delivered once /studio has loaded (the auth
    /// handoff load must finish first), plus the identity of the current open-this-song
    /// load (so the web view lets that one /s/<slug> navigation through to the Studio).
    @State private var pendingPrompt: StudioPromptRequest?
    @State private var pendingSong: StudioSongRequest?
    @State private var songLoadID: UUID?
    /// Set by the publish sheet on success; consumed when the sheet dismisses.
    @State private var lastPublished: PublishResult?

    var body: some View {
        // Composer input must always be visible (keyboard up or down, during playback). Keyboard handling:
        // the web view is NOT `.ignoresSafeArea(.keyboard)`, so SwiftUI shrinks it to the area above the keyboard
        // (and above the tab bar when the keyboard is down). The page then sees a smaller viewport and pins its
        // shell to visualViewport (`--app-h`, src/midireader.tsx), keeping the bottom composer on screen.
        // Native Scan entry: a slim bar ABOVE the web view (stacked, not overlaid), so it can never cover the
        // web toolbar or the bottom composer input.
        VStack(spacing: 0) {
            StudioNativeBar(onScan: { scan.start() }, onTestMIDI: { scan.loadTestMIDI() },
                            onTestFocus: { scan.webView?.evaluateJavaScript("window.dispatchEvent(new Event('gbk:focus-composer'))") })
            // The web view gets an explicit frame equal to the safe-area-bounded space, so it ends at the top of the
            // tab bar (iOS 26's floating glass bar otherwise lets it extend underneath, hiding web sheets' bottom
            // buttons) and above the keyboard. Its own safe-area insets are then 0 at the bottom.
            GeometryReader { g in
                Group {
                    if let url {
                        // A publish request follows finished work in the Studio: refresh `/api/me`
                        // so the paywall watcher (#123) sees any eligibility flip promptly.
                        WebView(url: url, scan: scan, songLoad: songLoadID, onLoad: { loaded in
                            // A pending "Remix this prompt" takes this load: hand the song slug +
                            // prompt to the page (the web reads gbk.composerRemix on the focus
                            // event and loads a fork of the song) instead of the draft check.
                            if let prompt = pendingPrompt {
                                pendingPrompt = nil
                                deliverRemix(prompt)
                            } else if let song = pendingSong {
                                pendingSong = nil
                                loadSong(song)
                            // App launch (or any full load that restored a project): same draft check.
                            } else if Self.humHarnessURL == nil, loaded.query?.contains("new=") != true { Task { await freshIfNoDraft(waitForRestore: true) } }
                        }, onPublish: { r in publishRequest = r; Task { await auth.loadMe() } },
                           onDeepLink: { router.open($0) })
                            .accessibilityIdentifier("studio-webview")
                    } else { ProgressView().tint(Theme.accent) }
                }
                .frame(width: g.size.width, height: g.size.height)
                .clipped()
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .preferredColorScheme(Self.forcedScheme)
        .sheet(isPresented: $scan.isPresented) { ScanSheetView(controller: scan) }
        .sheet(item: $publishRequest, onDismiss: {
            // Visual confirmation: a successful publish lands on the song's feed card
            // (focused and playing) instead of dropping back into the Studio, where
            // nothing showed the publish had worked.
            if let r = lastPublished {
                lastPublished = nil
                router.open(.share(slug: r.slug))
            }
        }) { r in
            NativePublishSheet(draft: PublishDraft(title: r.title, labels: Array(r.labels.prefix(PublishDraft.maxLabels)), tags: Array(r.tags.prefix(PublishDraft.maxTags))),
                               projectId: r.projectId, slug: r.slug, service: GuestPublishServices.make(webView: scan.webView),
                               onPublished: { res in published = true; lastPublished = res },
                               onClose: { publishRequest = nil })
        }
        // Entering Create from another tab: resume a draft as is; start fresh only when the latest project was
        // published (any route), is empty, or after a native publish. Sheets (publish, scan, MIDI import) don't change
        // the tab, so returning from them never resets.
        .onChange(of: router.selectedTab) { old, new in
            if new == .create, old != .create, url != nil, Self.humHarnessURL == nil { Task { await freshIfNoDraft() } }
        }
        // Feed card "open" / fork and "Remix this prompt" requests. onChange covers a
        // mounted Studio; the .task below covers a request that arrived before the
        // Studio was first mounted (onChange does not fire for the initial value).
        .onChange(of: router.studioSong) { _, req in if let req { handleStudioSong(req) } }
        .onChange(of: router.studioPrompt) { _, req in if let req { handleStudioPrompt(req) } }
        .task {
            if let req = router.studioSong { handleStudioSong(req) }
            if let req = router.studioPrompt { handleStudioPrompt(req) }
        }
        .task(id: auth.accessToken) {
            if let harness = Self.humHarnessURL { url = harness; return }
            let token = auth.accessToken
            if url != nil, urlToken == token { return } // tab re-entry: keep the live page (freshIfNoDraft decides)
            let path = Self.studioPath(fresh: false)
            let handoff = try? await AuthServices.current.webSessionURL(returnPath: path)
            if Task.isCancelled { return }
            urlToken = token
            url = (handoff ?? nil) ?? URL(string: path, relativeTo: Self.studioURL)!.absoluteURL
        }
    }
}

extension StudioWebView {
    /// Feed card "open" / fork: load the song's /s/<slug> page in the Studio — its web
    /// share flow loads the song into the workstation (?fork=1 forks it). Queued behind
    /// the auth handoff when the Studio has not loaded yet.
    @MainActor func handleStudioSong(_ req: StudioSongRequest) {
        router.studioSong = nil
        if url == nil { pendingSong = req } else { loadSong(req) }
    }

    @MainActor func loadSong(_ req: StudioSongRequest) {
        var comps = URLComponents(url: Self.studioURL, resolvingAgainstBaseURL: false)!
        comps.path = "/s/\(req.slug)"
        // A bare /s/<slug> is the web feed card; the studio share route needs ?edit=1 (read-only) or ?fork=1.
        comps.queryItems = [req.fork ? URLQueryItem(name: "fork", value: "1") : URLQueryItem(name: "edit", value: "1")]
        songLoadID = req.id
        url = comps.url
    }

    /// Feed card "Remix this prompt": same handoff the web card performs (sessionStorage
    /// remix payload + focus event), delivered to the loaded Studio page, or queued for
    /// the /studio load it triggers.
    @MainActor func handleStudioPrompt(_ req: StudioPromptRequest) {
        router.studioPrompt = nil
        if let web = scan.webView, web.url?.path.hasPrefix("/studio") == true {
            deliverRemix(req)
        } else {
            pendingPrompt = req
            if url?.path.hasPrefix("/studio") != true {
                url = URL(string: Self.studioPath(fresh: false), relativeTo: Self.studioURL)!.absoluteURL
            }
        }
    }

    /// Mirror of the web card's `remix()`: stash {slug, prompt} (prompt capped at 4,000
    /// chars like the web) as gbk.composerRemix in sessionStorage and fire the focus
    /// event the composer listens for. The web side loads a fork of the song from the
    /// slug; without it the remix would land in an empty project (#162).
    @MainActor func deliverRemix(_ req: StudioPromptRequest) {
        guard let web = scan.webView else { return }
        let payload: [String: String] = ["slug": req.slug, "prompt": String(req.text.prefix(4000))]
        let json = (try? JSONSerialization.data(withJSONObject: [payload])).flatMap { String(data: $0, encoding: .utf8) } ?? "[{}]"
        let js = "sessionStorage.setItem('gbk.focusComposer','1'); sessionStorage.setItem('gbk.composerRemix', JSON.stringify(\(json)[0])); window.dispatchEvent(new Event('gbk:focus-composer'));"
        web.evaluateJavaScript(js)
    }
}

extension StudioWebView {
    /// Truthy while a composer run, hum recording or other busy step is in progress.
    static let busyScript = "!!document.querySelector('[data-testid=studio-busy],[data-status=running],.ms-rec')"

    /// The web owns the rule (docs/social-api.md, `window.gbkStudio`): resume only when
    /// `hasContent && (!published || dirtySincePublish)`; otherwise `startNew()` (saves, then a blank project).
    /// On a full load we first give the IndexedDB restore a moment to land.
    static let entryScript = """
    const t0 = Date.now();
    while (!window.gbkStudio && Date.now() - t0 < 5000) await new Promise(r => setTimeout(r, 100));
    const g = window.gbkStudio; if (!g) return "unavailable";
    if (waitForRestore) { while (!g.currentProject().hasContent && Date.now() - t0 < 3000) await new Promise(r => setTimeout(r, 150)); }
    try { await g.refreshPublished(); } catch (e) {}
    const c = JSON.stringify(g.currentProject());
    if (afterPublish || !g.shouldResume()) { try { await g.flushSave(); } catch (e) {} await g.startNew(); return "new " + c; }
    return "resume " + c;
    """

    @MainActor func freshIfNoDraft(waitForRestore: Bool = false) async {
        guard let web = scan.webView else { return }
        if web.microphoneCaptureState != .none { return } // hum recording
        if (try? await web.evaluateJavaScript(Self.busyScript)) as? Bool == true { return } // composer run
        let afterPublish = published
        published = false
        let r = try? await web.callAsyncJavaScript(Self.entryScript, arguments: ["waitForRestore": waitForRestore, "afterPublish": afterPublish], contentWorld: .page)
        NSLog("[gbk.create-entry] restore=%@ afterPublish=%@ url=%@ -> %@", "\(waitForRestore)", "\(afterPublish)", web.url?.absoluteString ?? "-", String(describing: r ?? "nil"))
    }
}

/// Native controls for the studio, stacked above the web view. Scan only: the web compact-head (title, play pill,
/// ⋯) is the studio's header, so this bar carries no title or playback and stays one slim row.
struct StudioNativeBar: View {
    var onScan: () -> Void
    var onTestMIDI: () -> Void = {}
    var onTestFocus: () -> Void = {}
    static let testMIDIEnabled = ProcessInfo.processInfo.arguments.contains("-uiTestStudioMIDI")
    var body: some View {
        HStack {
            if Self.testMIDIEnabled {
                Button("Load test MIDI", action: onTestMIDI).font(.caption).accessibilityIdentifier("load-test-midi")
                Button("Focus", action: onTestFocus).font(.caption).accessibilityIdentifier("test-focus-composer")
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
    /// Identity of a deliberate open-this-song load: the coordinator lets that one
    /// /s/<slug> main-frame navigation through instead of routing it to the feed.
    var songLoad: UUID? = nil
    var onLoad: (@MainActor (URL) -> Void)? = nil
    var onPublish: (@MainActor (PublishBridge.Request) -> Void)? = nil
    /// Song pages (/s/<slug>) open the native feed card instead of loading inside the studio.
    var onDeepLink: (@MainActor (DeepLink) -> Void)? = nil

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        HumBridge.install(on: config, bridge: context.coordinator.hum)
        PublishBridge.install(on: config, bridge: context.coordinator.publish)
        context.coordinator.publish.onPublish = onPublish
        context.coordinator.onLoad = onLoad
        context.coordinator.onDeepLink = onDeepLink
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
        context.coordinator.publish.onPublish = onPublish
        context.coordinator.onLoad = onLoad
        context.coordinator.onDeepLink = onDeepLink
        if let songLoad, songLoad != context.coordinator.seenSongLoad {
            context.coordinator.seenSongLoad = songLoad
            context.coordinator.allowSongPageOnce = true
        }
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
        var onLoad: (@MainActor (URL) -> Void)?
        var onDeepLink: (@MainActor (DeepLink) -> Void)?
        /// Set when the app itself asked the Studio to open a song (feed card "open"/fork);
        /// consumed by the next /s/<slug> navigation decision.
        var allowSongPageOnce = false
        var seenSongLoad: UUID?

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard let u = webView.url, u.path.hasPrefix("/studio") else { return }
            let f = onLoad
            Task { @MainActor in f?(u) }
        }
        let hum = HumBridge()
        let publish = PublishBridge()
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

        /// A main-frame navigation to a song page (/s/<slug>) becomes the native share deep link.
        static func songLink(_ url: URL?, mainFrame: Bool) -> DeepLink? {
            guard mainFrame, let url, case .share? = DeepLink(url: url) else { return nil }
            return DeepLink(url: url)
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if Self.isPurchaseLink(action.request.url) {
                decisionHandler(.cancel)
                Task { @MainActor in PurchaseStore.shared.presentPaywall(reason: "studio_link") }
            } else if allowSongPageOnce, Self.songLink(action.request.url, mainFrame: action.targetFrame?.isMainFrame ?? true) != nil {
                allowSongPageOnce = false
                decisionHandler(.allow)
            } else if let onDeepLink, let link = Self.songLink(action.request.url, mainFrame: action.targetFrame?.isMainFrame ?? true) {
                decisionHandler(.cancel)
                Task { @MainActor in onDeepLink(link) }
            } else {
                decisionHandler(.allow)
            }
        }
    }
}

