import Foundation
import WebKit

/// The one origin the Studio web view trusts with native bridges, the guest credential and the mic:
/// https://compose.grepawk.com on the default port. The bundled UI-test harness pages (file:) are trusted in Debug only.
enum WebTrust {
    static let origin = "https://\(DeepLink.host)"
    #if DEBUG
    static let trustsFileHarness = true
    #else
    static let trustsFileHarness = false
    #endif

    static func isTrusted(scheme: String?, host: String?, port: Int?) -> Bool {
        switch scheme?.lowercased() {
        case "file": return trustsFileHarness
        case "https": return host?.lowercased() == DeepLink.host && (port == nil || port == 0 || port == 443)
        default: return false
        }
    }

    static func isTrusted(_ origin: WKSecurityOrigin) -> Bool {
        isTrusted(scheme: origin.protocol, host: origin.host, port: origin.port)
    }

    static func isTrusted(_ url: URL?) -> Bool {
        guard let url else { return false }
        return isTrusted(scheme: url.scheme, host: url.host, port: url.port)
    }

    /// Wraps a document-start script so it only runs on the trusted origin (WKUserScript can't be origin-scoped).
    static func onlyOnTrustedOrigin(_ js: String) -> String {
        let file = trustsFileHarness ? "true" : "false"
        return "if (location.protocol === \"file:\" ? \(file) : location.origin === \"\(origin)\") { \(js) }"
    }
}
