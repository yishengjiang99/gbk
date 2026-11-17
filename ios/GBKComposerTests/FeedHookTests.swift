import XCTest
@testable import GBKComposer

final class FeedHookTests: XCTestCase {
    func testHookStartSecondsNullValidAndOutOfRange() {
        XCTAssertEqual(FeedPlayback.hookStartSeconds(hookStartMs: nil, durationSeconds: 60), 0)
        XCTAssertEqual(FeedPlayback.hookStartSeconds(hookStartMs: 0, durationSeconds: 60), 0)
        XCTAssertEqual(FeedPlayback.hookStartSeconds(hookStartMs: -1, durationSeconds: 60), 0)
        XCTAssertEqual(FeedPlayback.hookStartSeconds(hookStartMs: 8_000, durationSeconds: 10), 8)
        XCTAssertEqual(FeedPlayback.hookStartSeconds(hookStartMs: 10_000, durationSeconds: 10), 0)
        XCTAssertEqual(FeedPlayback.hookStartSeconds(hookStartMs: 12_000, durationSeconds: 10), 0)
        XCTAssertEqual(FeedPlayback.hookStartSeconds(hookStartMs: 8_000, durationSeconds: 0), 0)
        XCTAssertEqual(FeedPlayback.hookStartSeconds(hookStartMs: 8_000, durationSeconds: .infinity), 0)
    }

    func testCompletionUsesRemainingDuration() {
        let t0 = Date(timeIntervalSince1970: 1000)
        var hook = OpenImpression(song: "a", position: 0, feed: "for_you", modelVersion: "v", t0: t0, hookStartMs: 8_000)
        hook.sample(time: 8.0, duration: 10)
        hook.sample(time: 9.8, duration: 10)
        var e = hook.close(at: t0.addingTimeInterval(2))
        XCTAssertEqual(e.listenRatio, 0.9, accuracy: 1e-9)
        XCTAssertTrue(e.completed)
        XCTAssertFalse(e.replay)

        var short = OpenImpression(song: "b", position: 1, feed: "for_you", modelVersion: "v", t0: t0, hookStartMs: 8_000)
        short.sample(time: 8.0, duration: 10)
        short.sample(time: 8.8, duration: 10)
        e = short.close(at: t0.addingTimeInterval(1))
        XCTAssertEqual(e.listenRatio, 0.4, accuracy: 1e-9)
        XCTAssertFalse(e.completed)

        // Past-the-end hook plays from 0, so remaining is the full song.
        var clamped = OpenImpression(song: "c", position: 2, feed: "for_you", modelVersion: "v", t0: t0, hookStartMs: 20_000)
        for t in stride(from: 0.0, through: 9.0, by: 0.25) { clamped.sample(time: t, duration: 10) }
        e = clamped.close(at: t0.addingTimeInterval(9.5))
        XCTAssertEqual(e.listenRatio, 0.9, accuracy: 1e-9)
        XCTAssertTrue(e.completed)

        // "From start" widens remaining to the full duration and is not a replay.
        hook.playFromStart()
        hook.sample(time: 0, duration: 10)
        e = hook.close(at: t0.addingTimeInterval(3))
        XCTAssertFalse(e.replay)
        XCTAssertEqual(e.listenRatio, 0.18, accuracy: 1e-9) // 1.8s heard of 10s remaining
        XCTAssertFalse(e.completed)
    }
}
