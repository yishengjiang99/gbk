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

    func testSongURLOpensThatSong() throws {
        let slug = try deepSlug()
        for url in ["https://compose.grepawk.com/s/\(slug)", "gbk://s/\(slug)"] {
            let app = XCUIApplication()
            app.launchArguments = ["-deepLink", url]
            app.launch()
            let card = app.descendants(matching: .any)["feedCard-\(slug)"].firstMatch
            XCTAssertTrue(card.waitForExistence(timeout: 45), "card for \(slug) via \(url)")
            XCTAssertTrue(card.isHittable, "\(slug) is the visible card via \(url)")
            app.terminate()
        }
    }
}
