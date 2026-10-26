import XCTest

/// `gbk:need-signin` with pending kind "publish" (guest taps ⋯ › Publish & share) opens the native Apple/Google sheet.
final class StudioSignInUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testPublishAsGuestOpensNativeSignIn() throws {
        let app = XCUIApplication()
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
        XCTAssertTrue(google.waitForExistence(timeout: 10), "native sign-in sheet for pending publish")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "studio-publish-signin"; shot.lifetime = .keepAlways; add(shot)
    }
}
