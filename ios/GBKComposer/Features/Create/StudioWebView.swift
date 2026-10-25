import SwiftUI
import WebKit

/// Studio in a WKWebView. When signed in, tries the iOS-1 web-code handoff
/// (`POST /api/auth/web-code` → `/api/auth/web-code/redeem?return=/studio`); falls back to /studio on 404.
struct StudioWebView: View {
    static let studioURL = URL(string: "https://compose.grepawk.com/studio")!
    @EnvironmentObject private var auth: AuthStore
    @State private var url: URL?

    var body: some View {
        Group {
            if let url { WebView(url: url) } else { ProgressView().tint(Theme.accent) }
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
        view.isOpaque = false
        view.backgroundColor = .clear
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
    final class Coordinator { var loaded: URL? }
}
