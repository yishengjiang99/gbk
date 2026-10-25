import XCTest
@testable import GBKComposer

final class APIClientTests: XCTestCase {
    let sample = """
    {"shares":[
      {"slug":"abc123","title":"Sky Waltz","owner":"yisheng","createdAt":"2026-10-01T12:00:00.000Z","public":true,
       "updatedAt":"2026-10-02T12:00:00.000Z","projectId":null,"parent":null,"hasMidi":true,"hasWav":true,"hasMp3":true,
       "wav":{"sampleRate":44100,"bytes":1000},"forks":2},
      {"slug":"def456","title":"Remix","owner":"guest","createdAt":"2026-10-03T12:00:00.000Z","public":true,
       "updatedAt":"2026-10-03T12:00:00.000Z","projectId":"p1","parent":{"slug":"abc123","title":"Sky Waltz","owner":"yisheng"},
       "hasMidi":true,"hasWav":false,"hasMp3":false,"wav":null,"forks":0}
    ]}
    """.data(using: .utf8)!

    func testDecodesSharesResponse() throws {
        let page = try JSONDecoder().decode(FeedPage.self, from: sample)
        XCTAssertEqual(page.shares.count, 2)
        XCTAssertEqual(page.shares[0].slug, "abc123")
        XCTAssertTrue(page.shares[0].hasMp3)
        XCTAssertEqual(page.shares[0].forks, 2)
        XCTAssertNil(page.shares[0].parent)
        XCTAssertEqual(page.shares[1].parent?.slug, "abc123")
        XCTAssertNil(page.nextCursor)
    }

    func testBuildsSharesRequestWithBearer() throws {
        let client = APIClient(tokenProvider: { "tok" })
        let req = try client.request(for: Endpoints.shares(limit: 20, offset: 40))
        XCTAssertEqual(req.url?.absoluteString, "https://compose.grepawk.com/api/shares?limit=20&offset=40")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertEqual(client.mediaURL(slug: "abc123", kind: "mp3").absoluteString,
                       "https://compose.grepawk.com/api/shares/abc123/media/mp3")
    }

    func testDeepLinks() {
        XCTAssertEqual(DeepLink(url: URL(string: "https://compose.grepawk.com/s/abc")!), .share(slug: "abc"))
        XCTAssertEqual(DeepLink(url: URL(string: "https://compose.grepawk.com/u/bob")!), .user(name: "bob"))
        XCTAssertEqual(DeepLink(url: URL(string: "https://compose.grepawk.com/t/9")!), .thread(id: "9"))
        XCTAssertNil(DeepLink(url: URL(string: "https://example.com/s/abc")!))
    }
}
