import Foundation
import SwiftUI

enum DeepLink: Equatable {
    case share(slug: String)   // /s/:slug
    case user(name: String)    // /u/:user
    case thread(id: String)    // /t/:id

    static let host = "compose.grepawk.com"

    init?(url: URL) {
        if let h = url.host, url.scheme?.hasPrefix("http") == true, h != DeepLink.host { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count >= 2 else { return nil }
        let value = parts[1]
        switch parts[0] {
        case "s": self = .share(slug: value)
        case "u": self = .user(name: value)
        case "t": self = .thread(id: value)
        default: return nil
        }
    }
}

@MainActor
final class DeepLinkRouter: ObservableObject {
    @Published var selectedTab: AppTab = .feed
    @Published var pending: DeepLink?

    func handle(_ url: URL) {
        guard let link = DeepLink(url: url) else { return }
        pending = link
        switch link {
        case .share: selectedTab = .feed
        case .user: selectedTab = .profile
        case .thread: selectedTab = .inbox
        }
    }
}
