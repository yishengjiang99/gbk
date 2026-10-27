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
                result = items.last(where: { ($0["media"] as? [String: Any])?["mp3"] is String })?["slug"] as? String
            }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 30)
        return try XCTUnwrap(result, "no song with audio on prod feed")
    }

    /// A published song with audio and its author's handle (the author's profile lists it).
    private func authoredSong() throws -> (slug: String, handle: String) {
        let url = URL(string: "https://compose.grepawk.com/api/feed?sort=new&limit=50")!
        var result: (String, String)?
        let done = expectation(description: "feed")
        URLSession.shared.dataTask(with: url) { data, _, _ in
            if let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let items = obj["items"] as? [[String: Any]],
               let it = items.first(where: { ($0["media"] as? [String: Any])?["mp3"] is String && ($0["author"] as? [String: Any])?["handle"] is String }),
               let slug = it["slug"] as? String, let h = (it["author"] as? [String: Any])?["handle"] as? String {
                result = (slug, h)
            }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 30)
        let r = try XCTUnwrap(result, "no authored song with audio on prod feed")
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
}
