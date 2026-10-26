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
        XCTAssertEqual(req.url?.absoluteString, "https://compose.grepawk.com/api/feed?sort=top&label=jazz&cursor=abc&limit=20&session=\(ImpressionLogger.session)")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertFalse(req.httpShouldHandleCookies)

        let rate = try client.request(for: Endpoints.rate("x", stars: 5))
        XCTAssertEqual(rate.httpMethod, "PUT")
        let body = try JSONSerialization.jsonObject(with: try XCTUnwrap(rate.httpBody)) as? [String: Int]
        XCTAssertEqual(body?["stars"], 5)
    }

    func testDeepLinks() {
        XCTAssertEqual(DeepLink(url: URL(string: "https://compose.grepawk.com/s/abcd")!), .share(slug: "abcd"))
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

@MainActor
final class CrossfadeTests: XCTestCase {
    func testOutgoingFadeOnly58ms() {
        XCTAssertEqual(FeedPlayer.crossfadeDuration, 0.058)
        XCTAssertEqual(FeedPlayer.incomingGain, 1, "next song starts at full volume immediately")
        XCTAssertEqual(FeedPlayer.fadeOutGain(0), 1, accuracy: 1e-6)
        XCTAssertEqual(FeedPlayer.fadeOutGain(0.5), Float(sqrt(0.5)), accuracy: 1e-6)
        XCTAssertEqual(FeedPlayer.fadeOutGain(1), 0, accuracy: 1e-6)
        XCTAssertEqual(FeedPlayer.fadeOutGain(2), 0, accuracy: 1e-6)
        XCTAssertGreaterThanOrEqual(FeedPlayer.fadeOutGain(0.3), FeedPlayer.fadeOutGain(0.6))
    }
}

/// Stubs URLSession responses by path.
final class StubProtocol: URLProtocol {
    static var handler: ((URLRequest) -> (Int, String))?
    static var requests: [URLRequest] = []
    static var extraHeaders: [String: String] = [:]
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        let (status, body) = Self.handler?(request) ?? (500, "{}")
        let resp = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["content-type": "application/json"].merging(Self.extraHeaders) { $1 })!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}

    static func session() -> URLSession {
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: c)
    }
}

final class LiveEndpointTests: XCTestCase {
    override func tearDown() { StubProtocol.handler = nil; StubProtocol.requests = [] }

    func testApple503IsNotAvailable() async {
        StubProtocol.handler = { _ in (503, #"{"code":"APPLE_UNAVAILABLE","message":"Sign in with Apple is not configured yet"}"#) }
        let service = LiveAuthService(client: APIClient(session: StubProtocol.session(), tokenProvider: { nil }))
        do { _ = try await service.exchangeApple(identityToken: "jwt", nonce: "n", displayName: nil); XCTFail("expected error") }
        catch { XCTAssertEqual(error as? APIError, .notAvailable) }
    }

    func testGoogleExchangeDecodesTokenPair() async throws {
        StubProtocol.handler = { req in
            XCTAssertEqual(req.url?.path, "/api/auth/google/native")
            return (200, #"{"access_token":"a1","token_type":"Bearer","expires_in":3600,"refresh_token":"r1","me":{"id":"u1","handle":"yisheng","display_name":"Yisheng","avatar_url":null,"song_count":1,"rating_avg":null,"created_at":0,"dm_policy":"all","handle_changed":false,"is_admin":false}}"#)
        }
        let service = LiveAuthService(client: APIClient(session: StubProtocol.session(), tokenProvider: { nil }))
        let pair = try await service.exchangeGoogle(idToken: "google-jwt")
        XCTAssertEqual(pair.accessToken, "a1")
        XCTAssertEqual(pair.me?.handle, "yisheng")
    }

    func testWebCodeBuildsRedeemURL() async throws {
        StubProtocol.handler = { _ in (200, #"{"code":"abc123","expires_in":60}"#) }
        let client = APIClient(session: StubProtocol.session(), tokenProvider: { "tok" })
        let code = try await client.send(Endpoints.webCode, as: WebCode.self)
        let url = try client.url(for: Endpoints.webCodeRedeemPath(code: code.code, returnPath: "/studio"))
        XCTAssertEqual(url.absoluteString, "https://compose.grepawk.com/api/auth/web-code/redeem?code=abc123&return=/studio")
        XCTAssertEqual(StubProtocol.requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
    }

    func testPushAndDeleteRequestShapes() async throws {
        StubProtocol.handler = { _ in (200, #"{"ok":true,"removed":true}"#) }
        let service = LiveAuthService(client: APIClient(session: StubProtocol.session(), tokenProvider: { "tok" }))
        try await service.registerPush(installId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", token: "ab12", environment: "sandbox")
        try await service.unregisterPush(installId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")
        try await service.deleteAccount()
        let reqs = StubProtocol.requests
        XCTAssertEqual(reqs.map { "\($0.httpMethod!) \($0.url!.path)" },
                       ["POST /api/push/register", "POST /api/push/unregister", "DELETE /api/me"])
        let body = try JSONSerialization.jsonObject(with: reqs[0].httpBodyStream.map(Self.read) ?? reqs[0].httpBody ?? Data()) as? [String: String]
        XCTAssertEqual(body?["installId"], "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
        XCTAssertEqual(body?["environment"], "sandbox")
    }

    func testGooglePKCEAndConfig() {
        // RFC 7636 appendix B test vector.
        XCTAssertEqual(GoogleSignIn.codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        let c = GoogleSignIn.Config(clientID: "1234-abc.apps.googleusercontent.com")
        XCTAssertEqual(c.reversedClientID, "com.googleusercontent.apps.1234-abc")
        XCTAssertEqual(c.redirectURI, "com.googleusercontent.apps.1234-abc:/oauth2redirect")
        let url = GoogleSignIn.authorizationURL(config: c, verifier: "v", state: "s")
        XCTAssertTrue(url.absoluteString.contains("code_challenge_method=S256"))
        XCTAssertNil(GoogleSignIn.Config.fromBundle(), "placeholder build setting = not available yet")
    }

    private static func read(_ stream: InputStream) -> Data {
        stream.open(); defer { stream.close() }
        var data = Data(); var buf = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable { let n = stream.read(&buf, maxLength: buf.count); if n <= 0 { break }; data.append(buf, count: n) }
        return data
    }
}

@MainActor
final class StudioKeyboardTests: XCTestCase {
    func testScrollResetOnlyWhenPageFits() {
        XCTAssertTrue(WebView.Coordinator.shouldReset(contentHeight: 700, boundsHeight: 700, offsetY: 120))
        XCTAssertFalse(WebView.Coordinator.shouldReset(contentHeight: 700, boundsHeight: 700, offsetY: 0))
        XCTAssertFalse(WebView.Coordinator.shouldReset(contentHeight: 1400, boundsHeight: 700, offsetY: 120), "scrollable pages keep their offset")
    }
}
