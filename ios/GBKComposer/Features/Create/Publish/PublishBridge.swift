import Foundation
import WebKit

/// Native publish hook (docs/social-api.md "Guest publish", web fecdb79): when `window.gbkNative` exists, web Publish
/// posts `webkit.messageHandlers.publish.postMessage({ projectId, title, labels, tags })` and stops; the app shows
/// NativePublishSheet. Guests publish without sign-in under the device's two-word username.
/// Also pins the web's fallback publish sheet to our web view's bottom: the web view already ends above the tab bar,
/// so `--pub-tabbar` is forced to 0.
@MainActor
final class PublishBridge: NSObject, WKScriptMessageHandler {
    struct Request: Equatable, Identifiable { var id: String { projectId }; var projectId: String; var title: String; var labels: [String]; var tags: [String] }
    static let handlerName = "publish"
    static let script = #"""
    (function () { var s = document.createElement("style"); s.textContent = ".pub-native, :root { --pub-tabbar: 0px !important; }";
      (document.head || document.documentElement).appendChild(s); })();
    """#

    var onPublish: (@MainActor (Request) -> Void)?

    static func install(on config: WKWebViewConfiguration, bridge: PublishBridge) {
        config.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(WeakPublishHandler(bridge), name: handlerName)
    }

    nonisolated static func request(from body: Any) -> Request? {
        guard let d = body as? [String: Any], let id = d["projectId"] as? String, !id.isEmpty else { return nil }
        var t = (d["title"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if t == "New song" || t == "Untitled" { t = "" }
        return Request(projectId: id, title: t, labels: (d["labels"] as? [String]) ?? [], tags: (d["tags"] as? [String]) ?? [])
    }

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard m.frameInfo.isMainFrame, HumBridge.isTrusted(m.frameInfo.securityOrigin),
              let r = Self.request(from: m.body) else { return }
        onPublish?(r)
    }
}

private final class WeakPublishHandler: NSObject, WKScriptMessageHandler {
    weak var target: PublishBridge?
    init(_ t: PublishBridge) { target = t }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        MainActor.assumeIsolated { target?.userContentController(c, didReceive: m) }
    }
}
