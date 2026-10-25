import XCTest
@testable import GBKComposer

final class DeepLinkTests: XCTestCase {
    private func link(_ s: String) -> DeepLink? { DeepLink(url: URL(string: s)!) }

    func testUniversalLinks() {
        XCTAssertEqual(link("https://compose.grepawk.com/s/ember-crown-rmpaqyj8"), .share(slug: "ember-crown-rmpaqyj8"))
        XCTAssertEqual(link("https://compose.grepawk.com/s/ember-crown-rmpaqyj8/"), .share(slug: "ember-crown-rmpaqyj8"))
        XCTAssertEqual(link("https://compose.grepawk.com/s/ember-crown-rmpaqyj8?fork=1"), .share(slug: "ember-crown-rmpaqyj8"))
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
        XCTAssertNil(link("https://compose.grepawk.com/"))
        XCTAssertNil(link("https://compose.grepawk.com/studio"))
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

    @MainActor func testFocusFetchesMissingSongAndPutsItFirst() async throws {
        let song = try APIClient.makeDecoder().decode(Song.self, from: Data(APIClientTests.docSong.utf8))
        let model = FeedViewModel()
        var fetched: [String] = []
        let ok = await model.focus(slug: song.slug) { fetched.append($0); return song }
        XCTAssertTrue(ok)
        XCTAssertEqual(fetched, [song.slug])
        XCTAssertEqual(model.items.first?.slug, song.slug)
        // Already loaded: no second fetch.
        _ = await model.focus(slug: song.slug) { fetched.append($0); return song }
        XCTAssertEqual(fetched.count, 1)
    }
}
