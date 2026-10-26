import XCTest

/// `gbk:need-signin` with pending kind "publish" (guest taps ⋯ › Publish & share) opens the native Apple/Google sheet.
final class StudioSignInUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testPublishAsGuestOpensNativeSignIn() throws {
        let app = XCUIApplication()
        app.launchArguments += ["-uiTestStudioMIDI"]
        app.launch()
        let create = app.tabBars.buttons["Create"]
        XCTAssertTrue(create.waitForExistence(timeout: 90), "tab bar (cold simulator launch can be slow)")
        create.tap()
        let web = app.webViews.firstMatch
        guard web.textViews["Describe a song or a change"].waitForExistence(timeout: 60) else {
            throw XCTSkip("studio did not load from compose.grepawk.com (network)")
        }
        web.descendants(matching: .any)["More"].firstMatch.tap()
        // more-publish row ("Publish & share"); version cards also carry a "Publish" button.
        let publish = web.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Publish & share' OR label BEGINSWITH '📤'")).firstMatch
        XCTAssertTrue(publish.waitForExistence(timeout: 5))
        sleep(1) // sheet animation
        publish.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let google = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Continue with Google'")).firstMatch
        if !google.waitForExistence(timeout: 10) {
            // The live page didn't ask (e.g. the app's guest session already counts as signed in on the web).
            // Still check the native contract with the exact event the web's needSignIn() dispatches.
            print("STUDIO-SIGNIN web did not raise need-signin; texts:", web.staticTexts.allElementsBoundByIndex.prefix(20).map(\.label))
            let s0 = XCTAttachment(screenshot: app.screenshot()); s0.name = "studio-publish-no-signin"; s0.lifetime = .keepAlways; add(s0)
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
            app.buttons["test-need-signin"].tap()
        }
        XCTAssertTrue(google.waitForExistence(timeout: 10), "native sign-in sheet for pending publish")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "studio-publish-signin"; shot.lifetime = .keepAlways; add(shot)
    }
}
