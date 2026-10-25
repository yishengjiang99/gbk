import XCTest
@testable import GBKComposer

@MainActor
final class GuestAndImpressionTests: XCTestCase {
    override func tearDown() async throws { AuthStore.shared.clearLocal() }

    func testEveryGeneratedNameMatchesServerRule() {
        for a in AnonymousIdentity.adjectives { for n in AnonymousIdentity.nouns {
            XCTAssertTrue(AnonymousIdentity.isValid(a + n), a + n)
        } }
        XCTAssertFalse(AnonymousIdentity.isValid("MellowFox482"))
        XCTAssertFalse(AnonymousIdentity.isValid("mellowfox"))
        XCTAssertFalse(AnonymousIdentity.isValid("Mellow Fox"))
    }

    /// Prod response shape (2026-10-25, ddf0e38): both naming styles, `me` and `user`.
    func testDecodesProdAnonymousResponse() throws {
        let json = #"{"token":"A","access_token":"A","token_type":"Bearer","expires_in":3600,"refreshToken":"R","refresh_token":"R","me":{"id":"u1","handle":"tidylantern","display_name":"TidyLantern","avatar_url":null,"song_count":0,"rating_avg":null,"created_at":1761400000000,"dm_policy":"off","handle_changed":false,"is_admin":false,"provider":"guest","is_guest":true},"user":{"id":"u1","handle":"tidylantern","display_name":"TidyLantern"}}"#
        let pair = try APIClient.makeDecoder().decode(TokenPair.self, from: Data(json.utf8))
        XCTAssertEqual(pair.accessToken, "A")
        XCTAssertEqual(pair.refreshToken, "R")
        XCTAssertEqual(pair.me?.isGuest, true)
        XCTAssertEqual(pair.me?.provider, "guest")
        XCTAssertEqual(pair.me?.displayName, "TidyLantern")
    }

    func testDeviceIDMatchesServerRule() {
        XCTAssertNotNil(AnonymousIdentity.deviceID.range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression))
    }

    func test429KeepsLocalNameAndSchedulesRetry() async {
        final class Limited: MockAuthService {
            override func registerAnonymous(deviceID: String, username: String) async throws -> TokenPair {
                throw APIError.rateLimited(retryAfter: 120, nil)
            }
        }
        let before = AnonymousIdentity.username
        let store = AuthStore()
        await store.ensureAnonymousSession(service: Limited())
        XCTAssertFalse(store.isSignedIn)
        XCTAssertEqual(AnonymousIdentity.username, before)
        XCTAssertEqual(store.anonymousRetryAfter, 120)
        store.clearLocal()
    }

    func testRetryAfterHeaderMapsToRateLimited() async throws {
        StubProtocol.extraHeaders = ["Retry-After": "42"]
        StubProtocol.handler = { _ in (429, #"{"code":"RATE_LIMITED","message":"guests can post 20 comments a day; sign in to lift the limit"}"#) }
        defer { StubProtocol.handler = nil; StubProtocol.extraHeaders = [:] }
        let client = APIClient(session: StubProtocol.session(), tokenProvider: { "t" })
        do { _ = try await client.send(Endpoints.postComment("s", body: "x"), as: Comment.self); XCTFail() }
        catch APIError.rateLimited(let after, let body) {
            XCTAssertEqual(after, 42)
            XCTAssertEqual(body?.message, "guests can post 20 comments a day; sign in to lift the limit")
        }
    }

    func testImpressionDwellRatioReplay() {
        let t0 = Date(timeIntervalSince1970: 1000)
        var o = OpenImpression(song: "a", position: 3, feed: "for_you", modelVersion: "lr-20261025", t0: t0)
        for t in stride(from: 0.0, through: 9.0, by: 0.25) { o.sample(time: t, duration: 10) }
        var e = o.close(at: t0.addingTimeInterval(9.5))
        XCTAssertEqual(e.dwellMs, 9500)
        XCTAssertEqual(e.listenRatio, 0.9, accuracy: 1e-9)
        XCTAssertTrue(e.completed)
        XCTAssertFalse(e.fastSkip)
        o.sample(time: 0.1, duration: 10) // looped back
        e = o.close(at: t0.addingTimeInterval(10))
        XCTAssertTrue(e.replay)
        let skip = OpenImpression(song: "b", position: 4, feed: "new", modelVersion: "new-1", t0: t0).close(at: t0.addingTimeInterval(1.2))
        XCTAssertTrue(skip.fastSkip)
        XCTAssertFalse(skip.completed)
        XCTAssertEqual(ImpressionLogger.json(skip)["model_version"] as? String, "new-1")
        XCTAssertEqual(ImpressionLogger.json(skip)["fast_skip"] as? Bool, true)
    }

    func testLoggerBatchesTenEventsAndMarksActions() async {
        let log = ImpressionLogger()
        var sent: [[Impression]] = []
        log.send = { sent.append($0) }
        for i in 0..<10 {
            log.start(song: "s\(i)", position: i, feed: "for_you", modelVersion: "v", time: { nil }, duration: { nil })
            if i == 2 { log.mark(.rate, song: "s2") }
        }
        log.end()
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(sent.first?.count, 10)
        XCTAssertEqual(sent.first?[2].actions, [.rate])
        XCTAssertTrue(log.queue.isEmpty)
    }

    func testGateRunsNowOrAfterSignIn() {
        let store = AuthStore(); store.clearLocal()
        var prompted: (String, SignInNeed)?
        var ran = 0
        let req = SignInRequester { reason, need, _ in prompted = (reason, need) }
        store.gate("Sign in to rate songs.", prompt: req) { ran += 1 }
        XCTAssertEqual(ran, 0)
        XCTAssertEqual(prompted?.0, "Sign in to rate songs.")
        store.store(TokenPair(accessToken: "g", tokenType: nil, expiresIn: nil, refreshToken: nil, me: nil), anonymous: true)
        store.gate("x", prompt: req) { ran += 1 }
        XCTAssertEqual(ran, 1, "guest session is enough to rate")
        prompted = nil
        store.gate("Sign in to see your profile and songs.", need: .linkedAccount, prompt: req) { ran += 1 }
        XCTAssertEqual(ran, 1)
        XCTAssertEqual(prompted?.1, .linkedAccount)
        XCTAssertTrue(RootTabView.isGated(.profile) && RootTabView.isGated(.inbox) && !RootTabView.isGated(.feed))
        store.clearLocal()
    }
}
