import XCTest

/// Publish from the studio in the app: native sheet (title, labels ≤3, tags ≤10, share-prompt toggle), no sign-in
/// (guests publish as the device's two-word username; service mocked until GBK Social's guest-publish contract).
/// Also: the studio web view ends above the tab bar, so no web sheet or the composer is covered.
final class StudioPublishUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testGuestPublishUsesNativeSheetWithoutSignIn() throws { try run(dark: false) }
    /// The sheet stays bright even when the system (forced via -uiTestDark) is dark.
    func testGuestPublishNativeSheetDark() throws { try run(dark: true) }

    private func run(dark: Bool) throws {
        let mode = dark ? "dark" : "light"
        let app = XCUIApplication()
        app.launchArguments += ["-uiTestStudioMIDI", "-uiTestPublishMock"] + (dark ? ["-uiTestDark"] : []) // mock: never publish to prod from CI
        app.launch()
        let create = app.tabBars.buttons["Create"]
        XCTAssertTrue(create.waitForExistence(timeout: 90))
        create.tap()
        let web = app.webViews.firstMatch
        let input = web.textViews["Describe a song or a change"]
        guard input.waitForExistence(timeout: 60) else { throw XCTSkip("studio did not load from compose.grepawk.com (network)") }

        let tabBar = app.tabBars.firstMatch.frame
        XCTAssertLessThanOrEqual(web.frame.maxY, tabBar.minY + 1, "web view \(web.frame) ends above the tab bar \(tabBar)")

        // Web publishes only a song with tracks: load a scale through the studio's MIDI import first.
        app.buttons["load-test-midi"].tap()
        let open = web.buttons["Open as new project"]
        if open.waitForExistence(timeout: 20) {
            for _ in 0..<3 where open.exists { open.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap(); sleep(2) }
        }
        web.descendants(matching: .any)["More"].firstMatch.tap() // studio-overflow
        let publish = web.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Publish & share' OR label BEGINSWITH '📤'")).firstMatch
        XCTAssertTrue(publish.waitForExistence(timeout: 5), "more-publish row")
        XCTAssertLessThanOrEqual(publish.frame.maxY, tabBar.minY + 1, "web sheet row above the tab bar")
        sleep(1)
        publish.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()

        let title = app.textFields["publish-title"]
        XCTAssertTrue(title.waitForExistence(timeout: 10), "native publish sheet")
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label CONTAINS 'Continue with Google'")).firstMatch.exists, "no sign-in")
        XCTAssertFalse(web.descendants(matching: .any)["Publish song"].exists, "web publish dialog not shown (native hook)")
        title.tap(); title.typeText(" Gentle Piano")
        app.buttons["publish-label-ambient"].tap()
        app.buttons["publish-label-jazz"].tap()
        let tag = app.textFields["publish-tag-input"]
        tag.tap(); tag.typeText("piano")
        app.buttons["publish-tag-add"].tap()
        XCTAssertTrue(app.buttons["publish-tag-piano"].waitForExistence(timeout: 3))
        app.switches["publish-share-prompt"].firstMatch.tap()
        attach(app, "studio-native-publish-\(mode)")
        let submit = app.buttons["publish-submit"]
        XCTAssertTrue(submit.waitForExistence(timeout: 3))
        XCTAssertTrue(submit.isHittable, "publish button hittable")
        submit.tap()
        XCTAssertTrue(app.staticTexts["publish-done"].waitForExistence(timeout: 10), "published (mock guest service)")
        attach(app, "studio-native-publish-done-\(mode)")
        app.buttons["publish-cancel"].tap()
        XCTAssertTrue(input.waitForExistence(timeout: 5) && input.isHittable, "composer visible after publish")
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = app.screenshot()
        let a = XCTAttachment(screenshot: shot); a.name = name; a.lifetime = .keepAlways; add(a)
        if let dir = ProcessInfo.processInfo.environment["SNAPSHOT_DIR"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }
}
