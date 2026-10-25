import XCTest

/// Standing rule: the composer input in the Create tab (studio WKWebView) is always visible,
/// keyboard up or down. Loads the live https://compose.grepawk.com/studio.
final class CreateTabKeyboardUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testComposerInputVisibleWithKeyboardDownAndUp() throws {
        let app = XCUIApplication()
        app.launch()
        app.tabBars.buttons["Create"].tap()

        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 30), "studio web view")
        let input = web.textViews.firstMatch
        guard input.waitForExistence(timeout: 60) else {
            attach(app, "create-tab-no-input")
            throw XCTSkip("composer input did not load from compose.grepawk.com/studio (network or web layout)")
        }
        let window = app.windows.firstMatch.frame
        let tabBar = app.tabBars.firstMatch.frame

        // Keyboard down: inside the window and above the tab bar.
        attach(app, "create-tab-keyboard-down")
        XCTAssertTrue(input.isHittable, "composer input hittable with keyboard down")
        XCTAssertTrue(window.contains(input.frame), "input \(input.frame) inside window \(window)")
        XCTAssertLessThanOrEqual(input.frame.maxY, tabBar.minY + 1, "input above the tab bar")

        // Keyboard up.
        input.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 10), "software keyboard (CI disables the hardware keyboard)")
        sleep(1) // let the keyboard animation and viewport resize settle
        attach(app, "create-tab-keyboard-up")
        XCTAssertTrue(input.isHittable, "composer input hittable with keyboard up")
        XCTAssertGreaterThanOrEqual(input.frame.minY, window.minY - 1, "input not scrolled above the top")
        XCTAssertLessThanOrEqual(input.frame.maxY, keyboard.frame.minY + 1, "input \(input.frame) above keyboard \(keyboard.frame)")

        input.typeText("calm piano in D minor")
        XCTAssertLessThanOrEqual(input.frame.maxY, keyboard.frame.minY + 1, "still visible while typing")
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = app.screenshot()
        let a = XCTAttachment(screenshot: shot)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
        if let dir = ProcessInfo.processInfo.environment["SNAPSHOT_DIR"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }
}
