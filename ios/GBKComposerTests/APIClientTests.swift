import XCTest
@testable import GBKComposer

/// Fixtures copied from docs/social-api.md (objects section, made concrete) plus one real prod feed item.
final class APIClientTests: XCTestCase {
    let decoder = APIClient.makeDecoder()

    static let docUser = #"{ "handle": "yisheng", "display_name": "Yisheng", "avatar_url": null, "song_count": 12, "rating_avg": 4.3, "created_at": 0 }"#

    static let docSong = """
    {
      "slug": "minuet-in-g-a1b2c3", "title": "Minuet in G", "url": "https://compose.grepawk.com/s/minuet-in-g-a1b2c3",
      "author": \(docUser), "created_at": 0, "published_at": 0,
      "labels": ["classical"], "tags": ["fugue", "piano"],
      "rating_avg": 4.5, "rating_count": 8, "comment_count": 3, "play_count": 120, "fork_count": 1,
      "my_rating": 5,
      "media": { "mp3": "https://compose.grepawk.com/api/shares/minuet-in-g-a1b2c3/media/mp3", "wav": null, "midi": null },
      "preview": { "notes": [[60, 0, 1, 0]], "duration": 32.0 },
      "prompt_shared": false, "prompt_text": null,
      "parent_slug": null, "is_mine": false
    }
    """

    /// Real item from GET https://compose.grepawk.com/api/feed (2026-10-25), notes trimmed. Prod preview shape differs from the doc.
    static let prodSong = """
    {"slug":"the-clockwork-cathedral-mfnrsu7g","title":"The Clockwork Cathedral","url":"https://compose.grepawk.com/s/the-clockwork-cathedral-mfnrsu7g",
     "author":{"handle":"yisheng","display_name":"yisheng","avatar_url":null,"song_count":11,"rating_avg":null,"created_at":1792953053171},
     "created_at":1792856337027,"published_at":1792856337027,"labels":[],"tags":[],"rating_avg":null,"rating_count":0,"comment_count":0,
     "play_count":0,"fork_count":0,"my_rating":null,
     "media":{"mp3":"https://compose.grepawk.com/api/shares/the-clockwork-cathedral-mfnrsu7g/media/mp3","wav":"https://compose.grepawk.com/api/shares/the-clockwork-cathedral-mfnrsu7g/media/wav","midi":"https://compose.grepawk.com/api/shares/the-clockwork-cathedral-mfnrsu7g/media/midi"},
     "preview":{"tracks":["#4fc3f7","#ffb74d"],"lo":38,"hi":86,"end":61440,"notes":[[4,0,4,46],[1,0,8,74]]},
     "prompt_shared":false,"prompt_text":null,"parent_slug":null,"is_mine":false}
    """

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try decoder.decode(T.self, from: Data(json.utf8))
    }

    func testDecodesDocFeedPage() throws {
        let page = try decode(FeedPage.self, #"{ "items": [\#(Self.docSong)], "next_cursor": "eyJrIjowfQ" }"#)
        let s = try XCTUnwrap(page.items.first)
        XCTAssertEqual(page.nextCursor, "eyJrIjowfQ")
        XCTAssertEqual(s.author.displayName, "Yisheng")
        XCTAssertEqual(s.tags, ["fugue", "piano"])
        XCTAssertEqual(s.myRating, 5)
        XCTAssertEqual(s.preview?.duration, 32.0)
        XCTAssertNotNil(s.mp3URL)
        XCTAssertNil(s.media?.wav)
    }

    func testDecodesProdFeedItem() throws {
        let page = try decode(FeedPage.self, #"{"items":[\#(Self.prodSong)],"next_cursor":null}"#)
        let s = try XCTUnwrap(page.items.first)
        XCTAssertNil(page.nextCursor)
        XCTAssertNil(s.ratingAvg)
        XCTAssertEqual(s.preview?.end, 61440)
        XCTAssertEqual(s.preview?.notes?.first, [4, 0, 4, 46])
    }

    func testDecodesProfileCommentsRatingMe() throws {
        let profile = try decode(UserProfilePage.self, #"{ "user": \#(Self.docUser), "songs": [\#(Self.prodSong)], "next_cursor": null }"#)
        XCTAssertEqual(profile.user.songCount, 12)
        XCTAssertEqual(profile.songs.count, 1)

        let comments = try decode(Page<Comment>.self, #"{ "items": [{ "id": "17", "author": \#(Self.docUser), "body": "nice", "created_at": 0, "can_delete": false }], "next_cursor": null }"#)
        XCTAssertEqual(comments.items.first?.id, "17")
        XCTAssertEqual(comments.items.first?.canDelete, false)

        let rating = try decode(RatingSummary.self, #"{ "rating_avg": 4.5, "rating_count": 9, "my_rating": 4 }"#)
        XCTAssertEqual(rating.myRating, 4)

        let me = try decode(Me.self, #"{ "id": "u1", "handle": "yisheng", "display_name": "Yisheng", "avatar_url": null, "song_count": 12, "rating_avg": 4.3, "created_at": 0, "dm_policy": "all", "handle_changed": false, "is_admin": false }"#)
        XCTAssertEqual(me.dmPolicy, "all")

        let pair = try decode(TokenPair.self, #"{ "access_token": "a", "token_type": "Bearer", "expires_in": 3600, "refresh_token": "r", "me": null }"#)
        XCTAssertEqual(pair.refreshToken, "r")

        let tags = try decode(TopTags.self, #"{"tags":[{"tag":"piano","count":3}],"labels":[{"label":"jazz","count":1}]}"#)
        XCTAssertEqual(tags.labels?.first?.label, "jazz")

        let err = try decode(APIErrorBody.self, #"{"code":"UNAUTHENTICATED","message":"sign in first"}"#)
        XCTAssertEqual(err.code, "UNAUTHENTICATED")
    }

    func testBuildsFeedRequestWithBearer() throws {
        let client = APIClient(tokenProvider: { "tok" })
        let req = try client.request(for: Endpoints.feed(FeedQuery(sort: .top, label: "jazz", tag: nil), cursor: "abc", limit: 20))
        XCTAssertEqual(req.url?.absoluteString, "https://compose.grepawk.com/api/feed?sort=top&label=jazz&cursor=abc&limit=20")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertFalse(req.httpShouldHandleCookies)

        let rate = try client.request(for: Endpoints.rate("x", stars: 5))
        XCTAssertEqual(rate.httpMethod, "PUT")
        let body = try JSONSerialization.jsonObject(with: try XCTUnwrap(rate.httpBody)) as? [String: Int]
        XCTAssertEqual(body?["stars"], 5)
    }

    func testDeepLinks() {
        XCTAssertEqual(DeepLink(url: URL(string: "https://compose.grepawk.com/s/abc")!), .share(slug: "abc"))
        XCTAssertEqual(DeepLink(url: URL(string: "https://compose.grepawk.com/u/bob")!), .user(name: "bob"))
        XCTAssertEqual(DeepLink(url: URL(string: "https://compose.grepawk.com/t/piano")!), .tag(name: "piano"))
        XCTAssertEqual(DeepLink(url: URL(string: "https://compose.grepawk.com/inbox/bob")!), .inbox(handle: "bob"))
        XCTAssertNil(DeepLink(url: URL(string: "https://example.com/s/abc")!))
    }
}

final class MockAuthServiceTests: XCTestCase {
    func testMockAuthFlows() async throws {
        let mock = MockAuthService()
        let pair = try await mock.exchangeApple(identityToken: "jwt", nonce: "n", displayName: nil)
        XCTAssertEqual(pair.me?.handle, "mockuser")
        let refreshed = try await mock.refresh(refreshToken: try XCTUnwrap(pair.refreshToken))
        XCTAssertNotEqual(refreshed.accessToken, pair.accessToken)
        do { _ = try await mock.refresh(refreshToken: "bogus"); XCTFail("expected 401") } catch APIError.unauthenticated {}
        try await mock.registerPush(installId: "i", token: "abcd", environment: "sandbox")
        XCTAssertEqual(mock.registeredPush["i"], "abcd")
        try await mock.unregisterPush(installId: "i")
        XCTAssertNil(mock.registeredPush["i"])
        let url = try await mock.webSessionURL(returnPath: "/studio")
        XCTAssertEqual(url?.path, "/api/auth/web-code/redeem")
        try await mock.deleteAccount()
        XCTAssertTrue(mock.deleted)
    }
}

final class ReviewerSignInTests: XCTestCase {
    func testFormBodyEncodesReservedCharacters() {
        let body = String(decoding: ReviewerSignIn.formBody(["password": "a&b=c d+", "username": "openai-reviewer"]), as: UTF8.self)
        XCTAssertEqual(body, "password=a%26b%3Dc%20d%2B&username=openai-reviewer")
    }
}
