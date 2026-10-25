import Foundation
import SwiftUI

enum DeepLink: Equatable {
    case share(slug: String)   // /s/:slug
    case user(name: String)    // /u/:user
    case tag(name: String)     // /t/:tag (doc: /t is a tag, not a thread)
    case inbox(handle: String) // /inbox/:handle

    static let host = "compose.grepawk.com"

    init?(url: URL) {
        if let h = url.host, url.scheme?.hasPrefix("http") == true, h != DeepLink.host { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count >= 2 else { return nil }
        let value = parts[1]
        switch parts[0] {
        case "s": self = .share(slug: value)
        case "u": self = .user(name: value)
        case "t": self = .tag(name: value)
        case "inbox": self = .inbox(handle: value)
        default: return nil
        }
    }
}

@MainActor
final class DeepLinkRouter: ObservableObject {
    @Published var selectedTab: AppTab = .feed
    @Published var pending: DeepLink?
    /// Handles pushed on the Feed tab's NavigationStack.
    @Published var feedPath: [String] = []

    func handle(_ url: URL) {
        guard let link = DeepLink(url: url) else { return }
        pending = link
        if case .user(let handle) = link { feedPath = [handle] }
        switch link {
        case .share, .user, .tag: selectedTab = .feed
        case .inbox: selectedTab = .inbox
        }
    }
}
