import XCTest
@testable import GBKComposer

/// #156: the real verifier over the wire (StubProtocol), and PurchaseStore's verdict on what the server says.
@MainActor
final class LiveIAPVerifierTests: XCTestCase {
    override func tearDown() { StubProtocol.handler = nil; StubProtocol.requests = [] }

    private func store(_ status: Int, _ body: String) -> PurchaseStore {
        StubProtocol.handler = { _ in (status, body) }
        let verifier = LiveIAPVerifier(client: APIClient(session: StubProtocol.session(), tokenProvider: { "tok" }))
        return PurchaseStore(verifier: verifier, accountId: { nil }, serverPro: { false }, serverMe: { nil })
    }

    func testPostsSignedTransactionWithLowercasedToken() async throws {
        let token = UUID()
        let o = await store(200, #"{"entitlements":["pro"],"expires_at":null}"#).verify(jws: "jws.payload.sig", token: token)
        XCTAssertEqual(o, .granted)
        let req = try XCTUnwrap(StubProtocol.requests.first)
        XCTAssertEqual("\(req.httpMethod!) \(req.url!.path)", "POST /api/iap/apple")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        let data = req.httpBodyStream.map(Self.read) ?? req.httpBody ?? Data()
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(body, ["signed_transaction": "jws.payload.sig", "app_account_token": token.uuidString.lowercased()])
    }

    func testServerVerdicts() async {
        let noGrant = await store(200, #"{"entitlements":[],"expires_at":null}"#).verify(jws: "j", token: UUID())
        XCTAssertEqual(noGrant, .notGranted)
        let owned = await store(409, #"{"code":"IAP_OWNED_BY_OTHER","message":"owned"}"#).verify(jws: "j", token: UUID())
        XCTAssertEqual(owned, .refused(PurchaseStore.refusalMessage(code: 409, body: nil)))
        let invalid = await store(400, #"{"code":"INVALID_JWS","message":"bad jws"}"#).verify(jws: "j", token: UUID())
        XCTAssertEqual(invalid, .refused("Couldn't activate Pro: bad jws"))
        for status in [500, 503, 429] {
            let o = await store(status, "{}").verify(jws: "j", token: UUID())
            XCTAssertEqual(o, .transient, "\(status)")
        }
    }

    private static func read(_ stream: InputStream) -> Data {
        stream.open(); defer { stream.close() }
        var data = Data(); var buf = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable { let n = stream.read(&buf, maxLength: buf.count); if n <= 0 { break }; data.append(buf, count: n) }
        return data
    }
}
