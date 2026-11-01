import XCTest
@testable import GBKComposer

final class DeepLinkTests: XCTestCase {
    private func link(_ s: String) -> DeepLink? { DeepLink(url: URL(string: s)!) }

    func testUniversalLinks() {
        XCTAssertEqual(link("https://compose.grepawk.com/s/ember-crown-rmpaqyj8"), .share(slug: "ember-crown-rmpaqyj8"))
        XCTAssertEqual(link("https://compose.grepawk.com/s/ember-crown-rmpaqyj8/"), .share(slug: "ember-crown-rmpaqyj8"))
        XCTAssertEqual(link("https://compose.grepawk.com/s/ember-crown-rmpaqyj8?fork=0"), .share(slug: "ember-crown-rmpaqyj8"))
        XCTAssertEqual(link("https://COMPOSE.grepawk.com/u/maestroaria"), .user(name: "maestroaria"))
        XCTAssertEqual(link("https://compose.grepawk.com/t/epic"), .tag(name: "epic"))
        XCTAssertEqual(link("https://compose.grepawk.com/feed"), .feed)
        XCTAssertEqual(link("https://compose.grepawk.com/explore"), .feed)
    }

    func testCustomScheme() {
        XCTAssertEqual(link("gbk://s/ember-crown-rmpaqyj8"), .share(slug: "ember-crown-rmpaqyj8"))
        XCTAssertEqual(link("gbk:///s/ember-crown-rmpaqyj8"), .share(slug: "ember-crown-rmpaqyj8"))
        XCTAssertEqual(link("gbk://u/maestroaria"), .user(name: "maestroaria"))
        XCTAssertEqual(link("gbk://feed"), .feed)
    }

    func testRejects() {
        XCTAssertNil(link("https://evil.example.com/s/ember-crown-rmpaqyj8"))
        XCTAssertNil(link("https://compose.grepawk.com/api/feed"))
        XCTAssertNil(link("https://compose.grepawk.com/s/ab"))          // slug too short
        XCTAssertNil(link("https://compose.grepawk.com/u/a"))           // handle too short
        XCTAssertNil(link("ftp://compose.grepawk.com/s/ember-crown-rmpaqyj8"))
        XCTAssertNil(link("gbk://x/whatever"))
    }

    @MainActor func testRouterSelectsTabAndProfile() {
        let r = DeepLinkRouter()
        r.selectedTab = .profile
        XCTAssertTrue(r.handle(URL(string: "https://compose.grepawk.com/s/ember-crown-rmpaqyj8")!))
        XCTAssertEqual(r.selectedTab, .feed)
        XCTAssertEqual(r.pending, .share(slug: "ember-crown-rmpaqyj8"))
        XCTAssertEqual(r.feedPath, [])
        XCTAssertTrue(r.handle(URL(string: "gbk://u/maestroaria")!))
        XCTAssertEqual(r.feedPath, ["maestroaria"])
        r.handleLaunchArguments(["app", "-deepLink", "gbk://s/ember-crown-rmpaqyj8"])
        XCTAssertEqual(r.pending, .share(slug: "ember-crown-rmpaqyj8"))
        XCTAssertEqual(r.feedPath, [])
        XCTAssertFalse(r.handle(URL(string: "https://example.com/s/x")!))
    }

    @MainActor func testStudioAndRootLinks() {
        let base = "https://compose.grepawk.com"
        XCTAssertEqual(DeepLink(url: URL(string: base + "/s/ember-crown-rmpaqyj8?edit=1")!), .studioSong(slug: "ember-crown-rmpaqyj8", fork: false))
        XCTAssertEqual(DeepLink(url: URL(string: base + "/s/ember-crown-rmpaqyj8?fork=1")!), .studioSong(slug: "ember-crown-rmpaqyj8", fork: true))
        XCTAssertEqual(DeepLink(url: URL(string: base + "/s/ember-crown-rmpaqyj8")!), .share(slug: "ember-crown-rmpaqyj8"))
        XCTAssertEqual(DeepLink(url: URL(string: base + "/")!), .feed)
        XCTAssertEqual(DeepLink(url: URL(string: base)!), .feed)
        XCTAssertEqual(DeepLink(url: URL(string: base + "/studio?new=1&mcp=abc")!), .studio(query: "new=1&mcp=abc"))
        let r = DeepLinkRouter()
        XCTAssertTrue(r.handle(URL(string: base + "/s/ember-crown-rmpaqyj8?fork=1")!))
        XCTAssertEqual(r.selectedTab, .create)
        XCTAssertEqual(r.studioSong?.slug, "ember-crown-rmpaqyj8")
        XCTAssertEqual(r.studioSong?.fork, true)
        XCTAssertTrue(r.handle(URL(string: base + "/studio?new=1")!))
        XCTAssertEqual(r.selectedTab, .create)
        XCTAssertEqual(r.studioLink?.path, "/studio?new=1")
        XCTAssertTrue(r.handle(URL(string: base + "/studio")!))
        XCTAssertEqual(r.studioLink?.path, "/studio")
        XCTAssertTrue(r.handle(URL(string: base + "/")!))
        XCTAssertEqual(r.selectedTab, .feed)
    }

    func testStudioWebRoute() {
        typealias C = WebView.Coordinator
        func r(_ s: String, main: Bool = true) -> C.Route { C.route(URL(string: s), mainFrame: main) }
        let b = "https://compose.grepawk.com"
        XCTAssertEqual(r(b + "/studio?new=1"), .allow)
        XCTAssertEqual(r(b + "/s/ember-crown-rmpaqyj8"), .allow)
        XCTAssertEqual(r(b + "/api/auth/web-code/redeem?code=x&return=/studio"), .allow)
        XCTAssertEqual(r(b + "/", main: false), .allow)
        XCTAssertEqual(r("https://accounts.google.com/x"), .allow)
        XCTAssertEqual(r("about:blank"), .allow)
        XCTAssertEqual(r(b + "/"), .link(.feed))   // studio ‹ Back (pushState "/"), via URL KVO
        XCTAssertEqual(r(b), .link(.feed))
        XCTAssertEqual(r(b + "/feed"), .link(.feed))
        XCTAssertEqual(r(b + "/inbox"), .tab(.inbox))
        XCTAssertEqual(r(b + "/profile"), .tab(.profile))
        XCTAssertEqual(r(b + "/u/maestroaria"), .link(.user(name: "maestroaria")))
        XCTAssertEqual(r(b + "/privacy"), .safari)
    }

    @MainActor func testFocusFetchesMissingSongAndPutsItFirst() async throws {
        // The native feed plays MIDI live through SF2, so a focusable song needs `media.midi`.
        let json = APIClientTests.docSong.replacingOccurrences(
            of: "\"midi\": null", with: "\"midi\": \"https://compose.grepawk.com/api/shares/minuet-in-g-a1b2c3/media/midi\"")
        let song = try APIClient.makeDecoder().decode(Song.self, from: Data(json.utf8))
        XCTAssertNotNil(song.midiURL)
        let model = FeedViewModel()
        var fetched: [String] = []
        let ok = await model.focus(slug: song.slug) { fetched.append($0); return song }
        XCTAssertTrue(ok)
        XCTAssertEqual(fetched, [song.slug])
        XCTAssertEqual(model.items.first?.slug, song.slug)
        // Already loaded: no second fetch.
        _ = await model.focus(slug: song.slug) { fetched.append($0); return song }
        XCTAssertEqual(fetched.count, 1)
        // Already loaded but not first (web 42adb71): pinned to card 0 with no duplicate, no fetch.
        let other = try APIClient.makeDecoder().decode(Song.self, from: Data(json.replacingOccurrences(of: song.slug, with: "other-song-x1").utf8))
        _ = await model.focus(slug: other.slug) { fetched.append($0); return other }
        XCTAssertEqual(model.items.map(\.slug), [other.slug, song.slug])
        let pinned = await model.focus(slug: song.slug) { fetched.append($0); return song }
        XCTAssertTrue(pinned)
        XCTAssertEqual(model.items.map(\.slug), [song.slug, other.slug])
        XCTAssertEqual(fetched.count, 2)
    }

    func testShareURLRoundTripsAndStudioDivertsSongPages() {
        let json = APIClientTests.docSong
        let song = try! APIClient.makeDecoder().decode(Song.self, from: Data(json.utf8))
        XCTAssertEqual(song.shareURL.absoluteString, "https://compose.grepawk.com/s/\(song.slug)")
        XCTAssertEqual(DeepLink(url: song.shareURL), .share(slug: song.slug))
        XCTAssertEqual(WebView.Coordinator.songLink(song.shareURL, mainFrame: true), .share(slug: song.slug))
        XCTAssertNil(WebView.Coordinator.songLink(song.shareURL, mainFrame: false))
        XCTAssertNil(WebView.Coordinator.songLink(URL(string: "https://compose.grepawk.com/studio?new=1"), mainFrame: true))
        XCTAssertNil(WebView.Coordinator.songLink(URL(string: "https://compose.grepawk.com/u/maestroaria"), mainFrame: true))
    }
}
