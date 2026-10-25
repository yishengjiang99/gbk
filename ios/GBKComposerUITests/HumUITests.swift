import XCTest

/// Native Hum through the web bridge. `-uiTestHum` loads the bundled hum-harness.html (the web side of the
/// contract); `-uiTestHumFixture` feeds hum-fixture.wav instead of the silent simulator mic. Real Core ML model.
final class HumUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testHumAddsHummedMelodyTrack() throws {
        let app = XCUIApplication()
        app.launchArguments += ["-uiTestHum", "-uiTestHumFixture"]
        app.launch()
        app.tabBars.buttons["Create"].tap()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 20))
        XCTAssertTrue(web.staticTexts["native: hum,midi"].waitForExistence(timeout: 20), "gbkNative capability injected")
        let hum = web.buttons["Hum"]
        XCTAssertTrue(hum.waitForExistence(timeout: 10))
        attach(app, "hum-idle")
        hum.tap()
        XCTAssertTrue(web.staticTexts["phase: recording"].waitForExistence(timeout: 10))
        attach(app, "hum-recording")
        let stop = web.buttons["Stop"]
        XCTAssertTrue(stop.waitForExistence(timeout: 5))
        stop.tap()
        let result = web.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Hummed melody:'")).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 90), "track added via gbkHum.apply")
        attach(app, "hum-result")
        XCTAssertTrue(result.label.contains("channel 1"), result.label) // channel 0 already used in the harness
        for p in ["60", "64", "67", "72"] { XCTAssertTrue(result.label.contains(p), "\(p) in \(result.label)") }
        XCTAssertTrue(web.textFields["composer input"].isHittable, "composer input still visible")
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
