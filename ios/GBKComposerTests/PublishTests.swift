import XCTest
@testable import GBKComposer

final class PublishDraftTests: XCTestCase {
    func testLabelsCapAtThree() {
        var d = PublishDraft()
        for l in ["ambient", "lofi", "jazz", "pop"] { d.toggleLabel(l) }
        XCTAssertEqual(d.labels, ["ambient", "lofi", "jazz"])
        d.toggleLabel("lofi")
        XCTAssertEqual(d.labels, ["ambient", "jazz"])
    }

    func testTagsArePlainTextDedupedAndCapped() {
        var d = PublishDraft()
        d.addTags("#Piano, fugue piano")
        XCTAssertEqual(d.tags, ["piano", "fugue"])
        d.addTags((1...20).map { "t\($0)" }.joined(separator: " "))
        XCTAssertEqual(d.tags.count, 10)
    }

    func testBridgeMessage() {
        XCTAssertEqual(PublishBridge.title(from: ["type": "publish", "title": " My Song "]), "My Song")
        XCTAssertEqual(PublishBridge.title(from: ["type": "publish", "title": "New song"]), "")
        XCTAssertNil(PublishBridge.title(from: ["type": "toggle"]))
    }

    func testMockGuestPublishUsesUsername() async throws {
        let r = try await MockGuestPublishService().publish(PublishDraft(title: "Gentle Piano"), as: "MellowFox")
        XCTAssertEqual(r.author, "MellowFox")
        XCTAssertTrue(r.url.absoluteString.hasPrefix("https://compose.grepawk.com/s/"))
    }
}
