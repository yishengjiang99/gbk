import XCTest

/// Launching with a song URL shows that exact song (fetched by slug when it isn't on the first feed page).
/// Hits prod (compose.grepawk.com) to pick a real slug deep in the feed.
final class DeepLinkUITests: XCTestCase {
    private func deepSlug() throws -> String {
        let url = URL(string: "https://compose.grepawk.com/api/feed?sort=new&limit=50")!
        var result: String?
        let done = expectation(description: "feed")
        URLSession.shared.dataTask(with: url) { data, _, _ in
            if let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let items = obj["items"] as? [[String: Any]] {
                result = items.last(where: { ($0["media"] as? [String: Any])?["midi"] is String })?["slug"] as? String
            }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 30)
        return try XCTUnwrap(result, "no song with MIDI on prod feed")
    }

    /// A published song with audio and its author's handle (the author's profile lists it).
    private func authoredSong() throws -> (slug: String, handle: String) {
        let url = URL(string: "https://compose.grepawk.com/api/feed?sort=new&limit=50")!
        var result: (String, String)?
        let done = expectation(description: "feed")
        URLSession.shared.dataTask(with: url) { data, _, _ in
            if let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let items = obj["items"] as? [[String: Any]],
               let it = items.first(where: { ($0["media"] as? [String: Any])?["midi"] is String && ($0["author"] as? [String: Any])?["handle"] is String }),
               let slug = it["slug"] as? String, let h = (it["author"] as? [String: Any])?["handle"] as? String {
                result = (slug, h)
            }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 30)
        let r = try XCTUnwrap(result, "no authored song with MIDI on prod feed (the native feed plays MIDI)")
        return (r.0, r.1)
    }

    /// Bug: profile song rows had no tap action. Tapping one must open that song in the feed (same path as /s/<slug>).
    func testProfileSongRowOpensThatSong() throws {
        let (slug, handle) = try authoredSong()
        let app = XCUIApplication()
        app.launchArguments = ["-deepLink", "https://compose.grepawk.com/u/\(handle)"]
        app.launch()
        let row = app.buttons["profileSong-\(slug)"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 45), "profile row for \(slug) on @\(handle)")
        row.tap()
        let card = app.descendants(matching: .any)["feedCard-\(slug)"].firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 45), "card for \(slug) after tapping the profile row")
        XCTAssertTrue(card.isHittable, "\(slug) is the visible card")
        sleep(2)
        let shot = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: shot); a.name = "profile-song-tapped"; a.lifetime = .keepAlways; add(a)
        if let dir = ProcessInfo.processInfo.environment["SNAPSHOT_DIR"] {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("profile-song-tapped.png"))
        }
    }

    func testSongURLOpensThatSong() throws {
        let slug = try deepSlug()
        for url in ["https://compose.grepawk.com/s/\(slug)", "gbk://s/\(slug)"] {
            let app = XCUIApplication()
            app.launchArguments = ["-deepLink", url]
            app.launch()
            let card = app.descendants(matching: .any)["feedCard-\(slug)"].firstMatch
            XCTAssertTrue(card.waitForExistence(timeout: 45), "card for \(slug) via \(url)")
            XCTAssertTrue(card.isHittable, "\(slug) is the visible card via \(url)")
            XCTAssertTrue(app.buttons["feed-share"].firstMatch.waitForExistence(timeout: 10), "Share button on the card")
            if url.hasPrefix("https"), let dir = ProcessInfo.processInfo.environment["SNAPSHOT_DIR"], !dir.isEmpty {
                try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
                try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("feed-card-share.png"))
            }
            app.terminate()
        }
    }

    // MARK: #189

    private func assertShowsCard(_ app: XCUIApplication, _ slug: String, _ why: String) {
        let card = app.descendants(matching: .any)["feedCard-\(slug)"].firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 45), "card for \(slug): \(why)")
        if app.alerts.firstMatch.waitForExistence(timeout: 2) { app.alerts.buttons.firstMatch.tap() } // "no audio yet"
        XCTAssertTrue(card.isHittable, "\(slug) is the visible card: \(why)")
    }

    /// @sunnywalrus showed "Couldn't load the profile."; tapping a song (not the first) must open that song.
    func testSunnywalrusProfileLoadsAndTapOpensThatSong() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-deepLink", "https://compose.grepawk.com/u/sunnywalrus"]
        app.launch()
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'profileSong-'"))
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 45), "profile songs for @sunnywalrus")
        XCTAssertFalse(app.staticTexts["Couldn't load the profile."].exists)
        let row = rows.element(boundBy: rows.count - 1)
        let slug = String(row.identifier.dropFirst("profileSong-".count))
        row.tap()
        assertShowsCard(app, slug, "tapped on @sunnywalrus")
    }

    /// Share link via the system (open(url:)) while the app isn't running.
    func testShareLinkColdStartOpensThatSong() throws {
        let slug = try deepSlug()
        let app = XCUIApplication()
        app.terminate()
        app.open(URL(string: "gbk://s/\(slug)")!)
        assertShowsCard(app, slug, "cold start")
    }

    /// Share link while the app is in the background, scrolled into the feed.
    func testShareLinkWarmStartOpensThatSong() throws {
        let slug = try deepSlug()
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'feedCard-'")).firstMatch.waitForExistence(timeout: 45))
        XCUIDevice.shared.press(.home)
        app.open(URL(string: "gbk://s/\(slug)")!)
        assertShowsCard(app, slug, "warm start")
    }
}
