import Foundation

/// Reading a push payload (server/src/push/notifier.ts): the APNs body carries
/// `kind` ("comment" | "fork" | "dm") and `link` (a compose.grepawk.com URL —
/// `/s/<slug>` for comment/fork, `/inbox/<handle>` for DMs) next to `aps`.
enum PushPayload {
    /// The deep link a tap should open, or nil when the payload carries nothing routable.
    /// The `link` is only trusted when `DeepLink` parses it (right host, valid slug/handle),
    /// so a stray or hostile payload can't steer navigation. Fallback: a DM payload with
    /// no usable link still lands in the recipient's own inbox.
    static func linkURL(from userInfo: [AnyHashable: Any], fallbackHandle: String? = nil) -> URL? {
        if let link = userInfo["link"] as? String, let url = URL(string: link), DeepLink(url: url) != nil {
            return url
        }
        if (userInfo["kind"] as? String) == "dm", let handle = fallbackHandle, !handle.isEmpty,
           let url = URL(string: "https://\(DeepLink.host)/inbox/\(handle)"), DeepLink(url: url) != nil {
            return url
        }
        return nil
    }
}

/// Hands a tapped push's link from `AppDelegate` (UIKit, no view hierarchy) to the
/// SwiftUI app's `DeepLinkRouter`. A value enqueued before the UI exists (cold
/// launch from a tap) stays pending until the app consumes it on appear; a value
/// enqueued while running is consumed via `onChange`. Consuming is one-shot.
@MainActor
final class PushLinkStore: ObservableObject {
    static let shared = PushLinkStore()

    @Published private(set) var pendingURL: URL?

    func enqueue(_ url: URL) { pendingURL = url }

    func consume() -> URL? {
        defer { pendingURL = nil }
        return pendingURL
    }
}
