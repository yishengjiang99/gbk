import XCTest

/// Standing rule: the composer input (web `composer-input`) in the Create tab is always visible: keyboard up or
/// down, during playback (`play-pill`). Loads the live chat-first https://compose.grepawk.com/studio (MobileStudio,
/// active because `window.gbkNative` exists). Runs light and dark (`-uiTestDark`; the app itself is locked Light).
/// Web test ids are reached through their aria-labels (WebKit exposes those, not data-testid):
/// composer-input "Describe a song or a change", plus-btn "Add", composer-send "Send", hum-btn "Hum a melody",
/// play-pill "Play"/"Pause", studio-overflow "More" (compact-head row), plus-sheet-music "Import sheet music".
final class CreateTabKeyboardUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testComposerAlwaysVisibleLight() throws { try run(dark: false) }
    func testComposerAlwaysVisibleDark() throws { try run(dark: true) }

    /// Yisheng: Create resumes an unpublished draft across tab switches (gbkStudio.shouldResume); the studio's own
    /// New starts a blank project. Published-and-unedited → fresh is the web rule (gbkStudio, docs/social-api.md).
    func testDraftSurvivesFeedToCreateAndNewStartsFresh() throws {
        let app = XCUIApplication()
        let title = "Draft \(UUID().uuidString.prefix(6))"
        app.launchArguments += ["-uiTestStudioMIDI", "-uiTestMIDIName", "\(title).mid"]
        app.launch()
        let create = app.tabBars.buttons["Create"]
        XCTAssertTrue(create.waitForExistence(timeout: 90))
        create.tap()
        let web = app.webViews.firstMatch
        guard web.textViews["Describe a song or a change"].waitForExistence(timeout: 60) else {
            throw XCTSkip("studio did not load from compose.grepawk.com")
        }
        // Unique title: an unpublished draft that can't match a song another test published (web matches by title too).
        let draft = web.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", String(title.prefix(8)))).firstMatch
        app.buttons["load-test-midi"].tap()
        let open = web.buttons["Open as new project"]
        if open.waitForExistence(timeout: 20) {
            for _ in 0..<3 where open.exists { open.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap(); sleep(2) }
        }
        XCTAssertTrue(draft.waitForExistence(timeout: 20), "imported draft is open")
        sleep(2)
        app.tabBars.buttons["Feed"].tap()
        sleep(1)
        create.tap()
        sleep(6) // entry check (gbkStudio.shouldResume)
        XCTAssertTrue(draft.exists, "unpublished draft resumes after Feed→Create")
        XCTAssertFalse(app.buttons["studio-new"].exists, "no duplicate native New (the studio has its own)")
        let newButton = web.buttons.matching(NSPredicate(format: "label CONTAINS 'New'")).firstMatch
        XCTAssertTrue(newButton.waitForExistence(timeout: 10), "studio ＋ New in the header")
        newButton.tap()
        let ok = app.alerts.buttons["OK"]
        if ok.waitForExistence(timeout: 5) { ok.tap() }
        XCTAssertTrue(draft.waitForNonExistence(timeout: 30), "New starts a blank project")
        XCTAssertTrue(web.textViews.firstMatch.waitForExistence(timeout: 30), "composer input visible")
        attach(app, "create-fresh")
    }

    private func run(dark: Bool) throws {
        let mode = dark ? "dark" : "light"
        let app = XCUIApplication()
        app.launchArguments += ["-uiTestStudioMIDI"] + (dark ? ["-uiTestDark"] : [])
        app.launch()
        let create = app.tabBars.buttons["Create"]
        XCTAssertTrue(create.waitForExistence(timeout: 90), "tab bar (cold simulator launch can be slow)")
        create.tap()

        let web = app.webViews.firstMatch
        XCTAssertTrue(web.waitForExistence(timeout: 30), "studio web view")
        let input = web.textViews["Describe a song or a change"]
        guard input.waitForExistence(timeout: 60) else {
            attach(app, "create-tab-no-input-\(mode)")
            throw XCTSkip("composer-input did not load from compose.grepawk.com/studio (network or web layout)")
        }
        let window = app.windows.firstMatch.frame
        let tabBar = app.tabBars.firstMatch.frame
        let plus = web.buttons["Add"], hum = web.buttons["Hum a melody"], more = web.descendants(matching: .any)["More"] // studio-overflow; aria-haspopup, so not a plain button
        let pill = web.buttons["Play"]
        _ = more.waitForExistence(timeout: 10)
        XCTAssertTrue(plus.exists && hum.exists && more.exists && pill.exists, "plus-btn, hum-btn, studio-overflow, play-pill")

        // Header: native Scan bar, then the web compact-head, no overlap or doubled top bar; safe areas respected.
        let bar = app.otherElements["studio-native-bar"].firstMatch
        XCTAssertTrue(app.buttons["scan-open"].exists, "native Scan bar kept")
        let barFrame = bar.exists ? bar.frame : app.buttons["scan-open"].frame
        XCTAssertGreaterThanOrEqual(barFrame.minY, app.statusBars.firstMatch.exists ? app.statusBars.firstMatch.frame.maxY - 1 : 0, "native bar below the status bar")
        XCTAssertGreaterThanOrEqual(more.frame.minY, barFrame.maxY - 1, "compact-head below the native bar")
        XCTAssertLessThan(more.frame.minY - barFrame.maxY, 30, "no empty safe-area gap doubled under the native bar")
        XCTAssertEqual(web.staticTexts.matching(NSPredicate(format: "label == 'Scan sheet music'")).count, 0, "no web Scan entry")

        // Keyboard down, empty project.
        attach(app, "create-empty-\(mode)")
        assertVisible(input, above: tabBar.minY, window, "keyboard down")

        // + sheet: no web photo Scan inside the app (Scan is native-only); Bluetooth pairing via gbkMidiNative.
        plus.tap()
        XCTAssertTrue(web.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Import MIDI file'")).firstMatch.waitForExistence(timeout: 5), "plus sheet opened")
        XCTAssertFalse(web.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Import sheet music'")).firstMatch.exists, "web photo Scan hidden in the app")
        web.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Connect MIDI keyboard'")).firstMatch.tap()
        XCTAssertTrue(web.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Pair a Bluetooth keyboard'")).firstMatch.waitForExistence(timeout: 5),
                      "gbkMidiNative.bluetooth + openBluetoothPairing() detected by the web")
        attach(app, "create-midi-sheet-\(mode)")
        assertVisible(input, above: tabBar.minY, window, "with the MIDI sheet open")
        web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap() // scrim closes the sheet
        sleep(1)

        // gbk:focus-composer focuses the input (software keyboard appears).
        app.buttons["test-focus-composer"].tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 10), "gbk:focus-composer focused composer-input")
        sleep(1)
        attach(app, "create-keyboard-up-\(mode)")
        assertVisible(input, above: keyboard.frame.minY, window, "keyboard up")
        input.typeText("calm piano in D minor")
        XCTAssertTrue(web.buttons["Send"].waitForExistence(timeout: 5), "composer-send appears with text")
        assertVisible(input, above: keyboard.frame.minY, window, "typing")
        attach(app, "create-typing-\(mode)")
        web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
        _ = keyboard.waitForNonExistence(timeout: 5)

        // Playback: load a scale through the studio's MIDI import, then play-pill.
        app.buttons["load-test-midi"].tap()
        let open = web.buttons["Open as new project"]
        if open.waitForExistence(timeout: 20) {
            for _ in 0..<3 where open.exists { open.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap(); sleep(2) }
        }
        XCTAssertTrue(pill.waitForExistence(timeout: 5))
        let enabled = expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: pill)
        wait(for: [enabled], timeout: 60)
        // The first tap can land while the SoundFont is still warming up: retry the pill a few times.
        let pause = web.buttons["Pause"]
        for _ in 0..<4 where !pause.exists {
            if pill.exists && pill.isEnabled { pill.tap() }
            if pause.waitForExistence(timeout: 20) { break }
        }
        XCTAssertTrue(pause.exists, "play-pill shows Pause while playing")
        sleep(1)
        attach(app, "create-playing-\(mode)")
        assertVisible(input, above: tabBar.minY, window, "during playback")
        input.tap()
        XCTAssertTrue(keyboard.waitForExistence(timeout: 10))
        sleep(1)
        attach(app, "create-playing-keyboard-up-\(mode)")
        assertVisible(input, above: keyboard.frame.minY, window, "playing, keyboard up")
        web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
        _ = keyboard.waitForNonExistence(timeout: 5)
        assertVisible(input, above: tabBar.minY, window, "after the keyboard closes")
    }

    private func assertVisible(_ input: XCUIElement, above limit: CGFloat, _ window: CGRect, _ when: String,
                               file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(input.isHittable, "composer-input hittable (\(when))", file: file, line: line)
        XCTAssertGreaterThanOrEqual(input.frame.minY, window.minY - 1, "not above the top (\(when))", file: file, line: line)
        XCTAssertLessThanOrEqual(input.frame.maxY, limit + 1, "input \(input.frame) above \(limit) (\(when))", file: file, line: line)
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
