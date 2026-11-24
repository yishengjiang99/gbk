import XCTest
@testable import GBKComposer

final class FeedViewScrollCueTests: XCTestCase {
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUpWithError() throws {
        suite = "FeedViewScrollCueTests-\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        defaults = nil
        suite = nil
    }

    func testShownUntilFirstSwipeThenNeverAgain() {
        var cue = FeedViewScrollCue(defaults: defaults, skipped: false)
        XCTAssertFalse(cue.showsHint)
        XCTAssertTrue(cue.firstSongStartedPlaying(hasNextCard: true), "schedule the bounce once")
        XCTAssertFalse(cue.firstSongStartedPlaying(hasNextCard: true), "don't schedule twice")
        XCTAssertTrue(cue.showsHint)

        cue.userScrolled()
        XCTAssertFalse(cue.bounceDeadlineReached(reduceMotion: false), "scroll before the bounce skips it")
        XCTAssertTrue(cue.showsHint, "hint stays until the first swipe to the next card")

        cue.swipedToNextCard(defaults: defaults)
        XCTAssertFalse(cue.showsHint)
        XCTAssertTrue(defaults.bool(forKey: FeedViewScrollCue.defaultsKey))

        var again = FeedViewScrollCue(defaults: defaults, skipped: false)
        XCTAssertFalse(again.firstSongStartedPlaying(hasNextCard: true))
        XCTAssertFalse(again.showsHint)
        XCTAssertFalse(again.bounceDeadlineReached(reduceMotion: false))
    }

    func testReduceMotionMeansNoBounce() {
        var reduced = FeedViewScrollCue(defaults: defaults, skipped: false)
        XCTAssertTrue(reduced.firstSongStartedPlaying(hasNextCard: true))
        XCTAssertFalse(reduced.bounceDeadlineReached(reduceMotion: true))
        XCTAssertTrue(reduced.showsHint)

        var cue = FeedViewScrollCue(defaults: defaults, skipped: false)
        XCTAssertTrue(cue.firstSongStartedPlaying(hasNextCard: true))
        XCTAssertTrue(cue.bounceDeadlineReached(reduceMotion: false))
        XCTAssertTrue(cue.showsHint)
    }
}
