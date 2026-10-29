import Foundation
import SwiftUI

/// Links the app opens. Universal Links (https://compose.grepawk.com/...) mirror the web router in
/// src/agent/routes.ts; the custom scheme gbk://s/<slug>, gbk://u/<handle> is the fallback.
enum DeepLink: Equatable {
    case share(slug: String)   // /s/:slug
    case user(name: String)    // /u/:user
    case tag(name: String)     // /t/:tag (doc: /t is a tag, not a thread)
    case inbox(handle: String) // /inbox/:handle
    case feed                  // /feed, /explore

    static let host = "compose.grepawk.com"
    static let scheme = "gbk"

    init?(url: URL) {
        let scheme = url.scheme?.lowercased()
        var parts = url.pathComponents.filter { $0 != "/" && !$0.isEmpty }
        switch scheme {
        case "https", "http":
            guard url.host?.lowercased() == DeepLink.host else { return nil }
        case DeepLink.scheme:
            // gbk://s/<slug>: the host is the first route segment. gbk:///s/<slug> also works.
            if let h = url.host, !h.isEmpty { parts.insert(h, at: 0) }
        default:
            return nil
        }
        guard let first = parts.first?.lowercased() else { return nil }
        if parts.count == 1 {
            if first == "feed" || first == "explore" { self = .feed; return }
            return nil
        }
        let value = parts[1]
        switch first {
        case "s":
            guard value.range(of: #"^[a-z0-9][a-z0-9-]{3,127}$"#, options: .regularExpression) != nil else { return nil }
            self = .share(slug: value)
        case "u":
            let h = value.lowercased()
            guard h.range(of: #"^[a-z0-9_]{3,20}$"#, options: .regularExpression) != nil else { return nil }
            self = .user(name: h)
        case "t": self = .tag(name: value.lowercased())
        case "inbox": self = .inbox(handle: value)
        default: return nil
        }
    }
}

/// A feed card asking the Studio (Create tab) to open a song, optionally as a fork.
struct StudioSongRequest: Equatable {
    let slug: String
    let fork: Bool
    let id = UUID()
}

/// A feed card asking the Studio to remix a shared song: the Studio loads the user's
/// fork of the song in a fresh composer session with the shared prompt prefilled
/// (the web card's "Remix this prompt", #162). The slug is what lets the Studio open
/// the song itself, not just the prompt text.
struct StudioPromptRequest: Equatable {
    let slug: String
    let text: String
    let id = UUID()
}

@MainActor
final class DeepLinkRouter: ObservableObject {
    @Published var selectedTab: AppTab = .feed
    @Published var pending: DeepLink?
    /// Handles pushed on the Feed tab's NavigationStack.
    @Published var feedPath: [String] = []
    /// One-shot requests from feed cards to the Studio web view.
    @Published var studioSong: StudioSongRequest?
    @Published var studioPrompt: StudioPromptRequest?

    /// Feed card "open" / fork buttons: switch to Create and load the song there.
    func openInStudio(slug: String, fork: Bool) {
        studioSong = StudioSongRequest(slug: slug, fork: fork)
        selectedTab = .create
    }

    /// Feed card "Remix this prompt": switch to Create; the Studio loads a fork of the
    /// song in a fresh session with the prompt prefilled.
    func remixPrompt(slug: String, prompt: String) {
        studioPrompt = StudioPromptRequest(slug: slug, text: prompt)
        selectedTab = .create
    }

    /// UI tests: `-deepLink <url>` routes the URL at launch (same path as onOpenURL on cold start).
    func handleLaunchArguments(_ args: [String] = ProcessInfo.processInfo.arguments) {
        if let i = args.firstIndex(of: "-deepLink"), i + 1 < args.count, let url = URL(string: args[i + 1]) { handle(url) }
    }

    @discardableResult
    func handle(_ url: URL) -> Bool {
        guard let link = DeepLink(url: url) else { return false }
        open(link)
        return true
    }

    func open(_ link: DeepLink) {
        switch link {
        case .user(let handle): feedPath = [handle]; pending = nil
        case .share, .tag, .feed: feedPath = []; pending = link
        case .inbox: pending = link
        }
        switch link {
        case .share, .user, .tag, .feed: selectedTab = .feed
        case .inbox: selectedTab = .inbox
        }
    }
}
