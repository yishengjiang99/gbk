import Foundation
import WebKit

/// Native publish for the studio web view (Yisheng, 2026-10-25: on iOS publishing needs no sign-in; guests publish
/// under the device's two-word username). Until GBK Social ships a native publish hook, a document-start script
/// catches taps on the studio's publish controls (more-publish row, version-card "Publish") in the capture phase,
/// stops the web PublishDialog, and posts `webkit.messageHandlers.publish.postMessage({ type: "publish", title })`.
/// Proposed web contract: web posts that message itself when `gbkNative.capabilities` has "publish".
@MainActor
final class PublishBridge: NSObject, WKScriptMessageHandler {
    static let handlerName = "publish"
    static let script = #"""
    document.addEventListener("click", function (e) {
      var t = e.target && e.target.closest && e.target.closest('[data-testid="more-publish"], [data-testid="version-publish"]');
      if (!t || t.disabled) return;
      e.preventDefault(); e.stopImmediatePropagation();
      var h = document.querySelector('[data-testid="studio-title"]');
      try { window.webkit.messageHandlers.publish.postMessage({ type: "publish", title: h ? h.textContent : "" }); } catch (_) {}
    }, true);
    """#

    var onPublish: (@MainActor (_ title: String) -> Void)?

    static func install(on config: WKWebViewConfiguration, bridge: PublishBridge) {
        config.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(WeakPublishHandler(bridge), name: handlerName)
    }

    nonisolated static func title(from body: Any) -> String? {
        guard let d = body as? [String: Any], d["type"] as? String == "publish" else { return nil }
        let t = (d["title"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return t == "New song" ? "" : t
    }

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard m.frameInfo.isMainFrame, HumBridge.isTrusted(m.frameInfo.securityOrigin),
              let title = Self.title(from: m.body) else { return }
        onPublish?(title)
    }
}

private final class WeakPublishHandler: NSObject, WKScriptMessageHandler {
    weak var target: PublishBridge?
    init(_ t: PublishBridge) { target = t }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        MainActor.assumeIsolated { target?.userContentController(c, didReceive: m) }
    }
}
