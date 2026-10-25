import SwiftUI
import WebKit

/// Studio in a WKWebView. When signed in, tries the iOS-1 web-code handoff
/// (`POST /api/auth/web-code` → `/api/auth/web-code/redeem?return=/studio`); falls back to /studio on 404.
struct StudioWebView: View {
    static let studioURL = URL(string: "https://compose.grepawk.com/studio")!
    @EnvironmentObject private var auth: AuthStore
    @State private var url: URL?

    var body: some View {
        // Composer input must always be visible (keyboard up or down, during playback). Keyboard handling:
        // the web view is NOT `.ignoresSafeArea(.keyboard)`, so SwiftUI shrinks it to the area above the keyboard
        // (and above the tab bar when the keyboard is down). The page then sees a smaller viewport and pins its
        // shell to visualViewport (`--app-h`, src/midireader.tsx), keeping the bottom composer on screen.
        Group {
            if let url { WebView(url: url).accessibilityIdentifier("studio-webview") } else { ProgressView().tint(Theme.accent) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background.ignoresSafeArea())
        .task(id: auth.accessToken) {
            let handoff = try? await AuthServices.current.webSessionURL(returnPath: "/studio")
            url = (handoff ?? nil) ?? Self.studioURL
        }
    }
}

struct WebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .clear
        // The page lays itself out to the visible viewport; don't let the scroll view add safe-area/keyboard
        // insets on top of the SwiftUI resize, or scroll a page that already fits (which pushes the composer off).
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.scrollView.bounces = false
        context.coordinator.pinWhenFitting(view.scrollView)
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        if uiView.url == nil || context.coordinator.loaded != url {
            context.coordinator.loaded = url
            uiView.load(URLRequest(url: url))
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator: NSObject, WKNavigationDelegate {
        var loaded: URL?
        private var offsetObservation: NSKeyValueObservation?

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
