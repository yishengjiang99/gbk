import XCTest

/// Regression: the feed view scroll cue (#248) broke swiping up to the next card.
final class FeedSwipeUITests: XCTestCase {
    func testSwipeUpWithScrollCueReachesNextCard() throws {
        let app = XCUIApplication()
        app.launchArguments += ["-UITestFeedScrollCue", "-gbk.feedScrollCueDone", "NO"]
        app.launchInTestMode()
        let hint = app.descendants(matching: .any)["feedViewScrollCue"].firstMatch
        XCTAssertTrue(hint.waitForExistence(timeout: 45), "cue shows once the first song plays")
        let cards = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'feedCard-'"))
        let first = cards.firstMatch.identifier
        app.swipeUp()
        let moved = NSPredicate { _, _ in !hint.exists }
        wait(for: [XCTNSPredicateExpectation(predicate: moved, object: nil)], timeout: 10)
        XCTAssertFalse(app.descendants(matching: .any)[first].isHittable, "first card scrolled away")
    }
}
