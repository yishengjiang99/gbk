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
        XCTAssertEqual(PublishBridge.request(from: ["projectId": "p1", "title": " My Song ", "labels": ["jazz"], "tags": []]),
                       PublishBridge.Request(projectId: "p1", title: "My Song", labels: ["jazz"], tags: []))
        XCTAssertEqual(PublishBridge.request(from: ["projectId": "p1", "title": "New song"])?.title, "")
        XCTAssertEqual(PublishBridge.request(from: ["projectId": "p1", "slug": "abc123", "title": "x"])?.slug, "abc123")
        XCTAssertNil(PublishBridge.request(from: ["projectId": "p1", "slug": "", "title": "x"])?.slug)
        XCTAssertNil(PublishBridge.request(from: ["title": "x"]))
    }

    @MainActor func testCapabilityScriptCarriesGuestIdentity() {
        let s = HumBridge.capabilityScript(deviceId: "0b6f4a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", guestName: "MellowFox")
        XCTAssertTrue(s.contains(#"deviceId: "0b6f4a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b""#))
        XCTAssertTrue(s.contains(#"guestName: "MellowFox""#))
        XCTAssertFalse(s.contains("scan"))
    }

    func testPublishErrorsMapFromThePage() {
        XCTAssertThrowsError(try WebViewGuestPublishService.result(["ok": false, "status": 429, "code": "GUEST_PUBLISH_LIMIT", "retryAfter": 7200])) {
            XCTAssertEqual($0 as? PublishError, .limit(retryAfter: 7200))
            XCTAssertTrue(($0 as? PublishError)?.message.contains("2 h") == true)
        }
        XCTAssertThrowsError(try WebViewGuestPublishService.result(["ok": false, "status": 429, "code": "RATE_LIMITED", "retryAfter": 60])) {
            XCTAssertEqual($0 as? PublishError, .rateLimited(retryAfter: 60))
        }
        XCTAssertThrowsError(try WebViewGuestPublishService.result(["ok": false, "status": 404, "code": "NOT_SAVED"])) {
            XCTAssertEqual($0 as? PublishError, .notSaved)
        }
        let r = try? WebViewGuestPublishService.result(["ok": true, "slug": "abc", "handle": "mellowfox2"])
        XCTAssertEqual(r?.author, "mellowfox2")
    }

    func testMockGuestPublishUsesUsername() async throws {
        let r = try await MockGuestPublishService().publish(PublishDraft(title: "Gentle Piano"), projectId: "p1", slug: "abc", as: "MellowFox")
        XCTAssertEqual(r.author, "mellowfox")
        XCTAssertTrue(r.url.absoluteString.hasPrefix("https://compose.grepawk.com/s/"))
    }
}
