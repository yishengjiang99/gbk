import XCTest

/// Native Scan end to end on the live studio: native "Scan sheet music" bar button -> sheet -> test sheet
/// (one-staff C major scale, real omr-homr-ios models) -> SMF -> studio's existing MIDI import chooser -> track.
final class ScanUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }
    override func tearDown() { XCUIDevice.shared.appearance = .light }

    private func openStudio(_ style: XCUIDevice.Appearance) throws -> XCUIApplication {
        XCUIDevice.shared.appearance = style
        let app = XCUIApplication()
        app.launchArguments += ["-uiTestScanFixture"]
        app.launch()
        app.tabBars.buttons["Create"].tap()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 30))
        guard web.textViews.firstMatch.waitForExistence(timeout: 60) else {
            throw XCTSkip("studio did not load from compose.grepawk.com (network)")
        }
        return app
    }

    func testScanEntryDark() throws {
        let app = try openStudio(.dark)
        XCTAssertTrue(app.buttons["scan-open"].isHittable)
        XCTAssertTrue(app.webViews.firstMatch.textViews.firstMatch.isHittable, "composer input visible with the scan bar")
        attach(app, "scan-ui-studio-dark")
        app.buttons["scan-open"].tap()
        XCTAssertTrue(app.buttons["scan-camera"].waitForExistence(timeout: 5))
        attach(app, "scan-ui-sheet-dark")
    }

    func testScanFixtureAddsTrackToStudio() throws {
        let app = try openStudio(.light)
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.textViews.firstMatch.isHittable, "composer input visible with the scan bar")
        attach(app, "scan-ui-studio-light")
        app.buttons["scan-open"].tap()
        let fixture = app.buttons["scan-fixture"]
        XCTAssertTrue(fixture.waitForExistence(timeout: 5))
        attach(app, "scan-ui-sheet-light")
        fixture.tap()
        // Real recognition on the simulator CPU/CoreML takes ~3 minutes.
        let newProject = web.buttons["Open as new project"]
        XCTAssertTrue(newProject.waitForExistence(timeout: 600), "studio MIDI import chooser opened with the scanned file")
        attach(app, "scan-ui-import-chooser-light")
        newProject.tap()
        let done = web.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Imported 1 track, 8 notes'")).firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 20), "studio imported the scanned track")
        attach(app, "scan-ui-imported-light")
        XCTAssertTrue(web.textViews.firstMatch.isHittable, "composer input still visible")
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
