import XCTest

/// gbk #108 simulator checks, run by .github/workflows/ios-sim-checks.yml (light and dark passes).
/// Skipped in the normal iOS CI (they hit prod and Safari). Screenshots go to SNAPSHOT_DIR with an appearance suffix.
final class SimChecksUITests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }
    private var suffix: String { env["APPEARANCE"] ?? "light" }

    override func setUpWithError() throws {
        continueAfterFailure = true
        try XCTSkipUnless(env["SIM_CHECKS"] == "1", "only in ios-sim-checks.yml")
    }

    /// Native feed: the playing card's viz changes frame to frame; after pausing it is static.
    func testNativeFeedOnlyPlayingCardAnimates() throws {
        let app = XCUIApplication()
        app.launch()
        let viz = app.otherElements["card-pianoroll"].firstMatch
        XCTAssertTrue(viz.waitForExistence(timeout: 30))
        sleep(6) // first song loads and autoplays
        save(app.screenshot(), "native-feed-playing-\(suffix)")
        let a = viz.screenshot().pngRepresentation; usleep(400_000)
        let b = viz.screenshot().pngRepresentation
        XCTAssertNotEqual(a, b, "playing card animates")
        viz.tap() // pause
        sleep(1)
        let c = viz.screenshot().pngRepresentation; usleep(400_000)
        let d = viz.screenshot().pngRepresentation
        XCTAssertEqual(c, d, "paused card draws statically")
        save(app.screenshot(), "native-feed-paused-\(suffix)")
        record("native: playing frames differ=\(a != b), paused frames equal=\(c == d)")
    }

    /// Web prod /feed in Safari (opened by the workflow with simctl openurl): first tap, then scroll to the next card.
    func testWebFeedInSafari() throws {
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        safari.activate()
        let web = safari.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 30))
        sleep(5)
        save(safari.screenshot(), "web-feed-loaded-\(suffix)")
        // Horizontal scroll check: a left swipe must not move the page.
        let before = safari.screenshot().pngRepresentation
        web.swipeLeft(); sleep(1)
        let after = safari.screenshot().pngRepresentation
        record("web: horizontal swipe changed page=\(before != after)")
        save(safari.screenshot(), "web-feed-after-swipe-left-\(suffix)")
        // First tap unlocks audio, then scroll-to-play on the next card.
        web.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.45)).tap(); sleep(3)
        save(safari.screenshot(), "web-feed-after-first-tap-\(suffix)")
        web.swipeUp(); sleep(4)
        save(safari.screenshot(), "web-feed-after-scroll-\(suffix)")
        let pauseVisible = web.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'pause'")).count
        record("web: pause buttons visible after scroll=\(pauseVisible)")
    }

    private func record(_ line: String) {
        print("SIMCHECK \(line)")
        guard let dir = env["SNAPSHOT_DIR"] else { return }
        let url = URL(fileURLWithPath: dir).appendingPathComponent("simchecks-\(suffix).txt")
        let old = (try? String(contentsOf: url)) ?? ""
        try? (old + line + "\n").write(to: url, atomically: true, encoding: .utf8)
    }

    private func save(_ shot: XCUIScreenshot, _ name: String) {
        let a = XCTAttachment(screenshot: shot); a.name = name; a.lifetime = .keepAlways; add(a)
        guard let dir = env["SNAPSHOT_DIR"] else { return }
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try? shot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }
}
