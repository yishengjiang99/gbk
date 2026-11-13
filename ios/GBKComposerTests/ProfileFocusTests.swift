import XCTest
@testable import GBKComposer

/// #189: profile load and profile/share-link taps opening the exact song.
@MainActor
final class ProfileFocusTests: XCTestCase {
    /// Trimmed live `GET /api/users/sunnywalrus`: nulls everywhere, `bio`, and songs with no MIDI.
    static let sunnywalrus = """
    {"user":{"handle":"sunnywalrus","display_name":"SunnyWalrus","bio":null,"badge":null,"pro":false,"avatar_url":null,"song_count":2,"rating_avg":null,"created_at":1792971095622},
     "songs":[
      {"slug":"die-letze-kompanie-32zb42ij","title":"Die letze Kompanie","url":"https://compose.grepawk.com/s/die-letze-kompanie-32zb42ij",
       "author":{"handle":"sunnywalrus","display_name":"SunnyWalrus","bio":null,"badge":null,"pro":false,"avatar_url":null,"song_count":2,"rating_avg":null,"created_at":1792971095622},
       "created_at":1793557236849,"published_at":1793557264735,"labels":["classical"],"tags":[],"rating_avg":null,"rating_count":0,"comment_count":0,
       "play_count":2,"fork_count":0,"my_rating":null,"media":{"mp3":null,"wav":null,"midi":null},
       "preview":{"tracks":["#ffb74d"],"lo":34,"hi":77,"end":47520,"notes":[[0,0,10,62]]},"prompt_shared":false,"prompt_text":null,"parent_slug":null,"is_mine":false},
      {"slug":"raspody-dgzx2twx","title":"Raspody","url":"https://compose.grepawk.com/s/raspody-dgzx2twx",
       "author":{"handle":"sunnywalrus","display_name":"SunnyWalrus","bio":null,"badge":null,"pro":false,"avatar_url":null,"song_count":2,"rating_avg":null,"created_at":1792971095622},
       "created_at":1792984982476,"published_at":null,"labels":[],"tags":[],"rating_avg":null,"rating_count":0,"comment_count":0,
       "play_count":0,"fork_count":0,"my_rating":null,"media":null,"preview":null,"prompt_shared":false,"prompt_text":null,"parent_slug":null,"is_mine":false}],
     "next_cursor":null}
    """

    private func page() throws -> UserProfilePage {
        try APIClient.makeDecoder().decode(UserProfilePage.self, from: Data(Self.sunnywalrus.utf8))
    }

    func testSunnywalrusProfileDecodes() throws {
        let p = try page()
        XCTAssertEqual(p.user.handle, "sunnywalrus")
        XCTAssertEqual(p.songs.map(\.slug), ["die-letze-kompanie-32zb42ij", "raspody-dgzx2twx"])
        XCTAssertNil(p.songs[0].midiURL)
    }

    func testAtPrefixedHandleHitsBareRoute() {
        XCTAssertEqual(Endpoints.user("@sunnywalrus", cursor: nil).path, "/api/users/sunnywalrus")
    }

    func testConcurrentLoadsDoNotDuplicateOrError() async throws {
        let p = try page()
        var calls = 0
        let model = ProfileModel { _, _ in calls += 1; try await Task.sleep(for: .milliseconds(50)); return p }
        async let a: Void = model.load(handle: "sunnywalrus")
        async let b: Void = model.load(handle: "sunnywalrus", reset: false)
        _ = await (a, b)
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(model.songs.map(\.slug), p.songs.map(\.slug))
        XCTAssertNil(model.error)
    }

    func testCancelledLoadIsNotAnError() async {
        let model = ProfileModel { _, _ in throw URLError(.cancelled) }
        await model.load(handle: "sunnywalrus")
        XCTAssertNil(model.error)
        let failing = ProfileModel { _, _ in throw URLError(.notConnectedToInternet) }
        await failing.load(handle: "sunnywalrus")
        XCTAssertEqual(failing.error, "Couldn't load the profile.")
    }

    func testFocusFailureIsVisibleAndKeepsFeed() async {
        let model = FeedViewModel()
        let ok = await model.focus(slug: "gone-song-x1") { _ in throw URLError(.timedOut) }
        XCTAssertFalse(ok)
        XCTAssertEqual(model.focusError, "Couldn't open that song.")
        let missing = await model.focus(slug: "gone-song-x1") { _ in throw APIError.notAvailable }
        XCTAssertFalse(missing)
        XCTAssertEqual(model.focusError, "That song isn't available.")
    }

    func testFocusShowsTheTappedSongEvenWithoutMIDI() async throws {
        let song = try page().songs[0]
        let model = FeedViewModel()
        let ok = await model.focus(slug: song.slug) { _ in song }
        XCTAssertTrue(ok)
        XCTAssertEqual(model.items.first?.slug, song.slug)
        XCTAssertEqual(model.focusError, "This song has no audio yet.")
    }

    /// #140: switching the query while a page is loading must load the new query, not strand on a spinner.
    func testQueryChangeMidLoadLoadsTheNewQuery() async throws {
        let json = APIClientTests.docSong.replacingOccurrences(
            of: "\"midi\": null", with: "\"midi\": \"https://compose.grepawk.com/api/shares/minuet-in-g-a1b2c3/media/midi\"")
        let song = try APIClient.makeDecoder().decode(Song.self, from: Data(json.utf8))
        let feed = GatedFeed(song: song)
        let model = FeedViewModel(provider: feed)
        let first = Task { await model.reload() }
        while feed.gate == nil { await Task.yield() }
        model.query.tag = "jazz"
        for _ in 0..<200 where model.items.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(model.items.map(\.slug), [song.slug])
        feed.gate?.resume()
        await first.value
        XCTAssertEqual(model.items.map(\.slug), [song.slug], "the old query's page is dropped")
        XCTAssertEqual(feed.queries.last?.tag, "jazz")
    }

    /// Cold start: the link is focused before the first feed page; the reload must keep it as card 0.
    func testPinnedSongSurvivesReload() async throws {
        let song = try page().songs[0]
        let model = FeedViewModel(provider: EmptyFeed())
        _ = await model.focus(slug: song.slug) { _ in song }
        await model.reload()
        XCTAssertEqual(model.items.map(\.slug), [song.slug])
        model.query.tag = "jazz" // a user filter change drops the pin
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(model.items.isEmpty)
    }
}

/// First call hangs until `gate` is resumed and returns an old-query page; later calls return `song`.
@MainActor
private final class GatedFeed: FeedProviding {
    let song: Song
    var gate: CheckedContinuation<Void, Never>?
    var queries: [FeedQuery] = []
    init(song: Song) { self.song = song }
    func feedPage(_ query: FeedQuery, cursor: String?, limit: Int) async throws -> FeedPage {
        queries.append(query)
        if queries.count == 1 {
            await withCheckedContinuation { gate = $0 }
            return FeedPage(items: [], nextCursor: "stale")
        }
        return FeedPage(items: [song], nextCursor: nil)
    }
}

private struct EmptyFeed: FeedProviding {
    func feedPage(_ query: FeedQuery, cursor: String?, limit: Int) async throws -> FeedPage {
        FeedPage(items: [], nextCursor: nil)
    }
}
