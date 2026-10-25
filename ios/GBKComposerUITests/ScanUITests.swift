import XCTest

/// Native Scan end to end on the live studio: native "Scan sheet music" bar button -> sheet -> test sheet
/// The app is locked to Light (Info.plist UIUserInterfaceStyle); dark rendering is covered by SnapshotTests.
/// (one-staff C major scale, real omr-homr-ios models) -> SMF -> studio's existing MIDI import chooser -> track.
final class ScanUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func openStudio() throws -> XCUIApplication {
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

    func testScanFixtureAddsTrackToStudio() throws {
        let app = try openStudio()
        let web = app.webViews.firstMatch
        XCTAssertTrue(web.textViews.firstMatch.isHittable, "composer input visible with the scan bar")
        attach(app, "scan-ui-studio")
        app.buttons["scan-open"].tap()
        let fixture = app.buttons["scan-fixture"]
        XCTAssertTrue(fixture.waitForExistence(timeout: 5))
        attach(app, "scan-ui-sheet")
        fixture.tap()
        // Real recognition on the simulator CPU/CoreML takes ~3 minutes.
        let newProject = web.buttons["Open as new project"]
        XCTAssertTrue(newProject.waitForExistence(timeout: 600), "studio MIDI import chooser opened with the scanned file")
        attach(app, "scan-ui-import-chooser")
        newProject.tap()
        let done = web.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Imported 1 track, 8 notes'")).firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 20), "studio imported the scanned track")
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: newProject)
        wait(for: [gone], timeout: 10)
        XCTAssertFalse(web.staticTexts["No tracks yet."].exists, "the studio now has the scanned track")
        sleep(1)
        attach(app, "scan-ui-imported")
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
