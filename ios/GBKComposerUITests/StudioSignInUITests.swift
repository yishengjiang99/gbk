import XCTest

/// `gbk:need-signin` with pending kind "publish" (guest taps ⋯ › Publish & share) opens the native Apple/Google sheet.
final class StudioSignInUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testPublishAsGuestOpensNativeSignIn() throws {
        let app = XCUIApplication()
        app.launch()
        app.tabBars.buttons["Create"].tap()
        let web = app.webViews.firstMatch
        guard web.textViews["Describe a song or a change"].waitForExistence(timeout: 60) else {
            throw XCTSkip("studio did not load from compose.grepawk.com (network)")
        }
        web.buttons["More"].tap()
        let publish = web.buttons.matching(NSPredicate(format: "label CONTAINS 'Publish'")).firstMatch
        XCTAssertTrue(publish.waitForExistence(timeout: 5))
        publish.tap()
        let google = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Continue with Google'")).firstMatch
        XCTAssertTrue(google.waitForExistence(timeout: 10), "native sign-in sheet for pending publish")
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "studio-publish-signin"; shot.lifetime = .keepAlways; add(shot)
    }
}
