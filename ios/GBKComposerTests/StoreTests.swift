import XCTest
@testable import GBKComposer

final class StoreTests: XCTestCase {
    func testCatalogMatchesStoreKitConfiguration() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("StoreKit/GBKComposer.storekit")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        var ids = Set<String>()
        for p in json["products"] as? [[String: Any]] ?? [] { ids.insert(p["productID"] as! String) }
        for g in json["subscriptionGroups"] as? [[String: Any]] ?? [] {
            XCTAssertEqual(g["name"] as? String, StoreCatalog.subscriptionGroup)
            for p in g["subscriptions"] as? [[String: Any]] ?? [] { ids.insert(p["productID"] as! String) }
        }
        XCTAssertEqual(ids, StoreCatalog.ids)
    }

    func testPurchaseLinksOpenPaywall() {
        let yes = ["https://compose.grepawk.com/pricing", "https://grepawk.com/api/compose/checkout?plan=pro_monthly",
                   "https://checkout.stripe.com/c/pay/cs_live_x"]
        let no = ["https://compose.grepawk.com/studio", "https://compose.grepawk.com/plans", "https://example.com/pricing"]
        for s in yes { XCTAssertTrue(WebView.Coordinator.isPurchaseLink(URL(string: s)), s) }
        for s in no { XCTAssertFalse(WebView.Coordinator.isPurchaseLink(URL(string: s)), s) }
    }

    func testAppAccountTokenUsesAccountUUIDElseStableInstallUUID() {
        let id = UUID()
        XCTAssertEqual(AppAccountToken.resolve(accountId: id.uuidString.lowercased()), id)
        XCTAssertEqual(AppAccountToken.resolve(accountId: "u_123"), AppAccountToken.resolve(accountId: nil))
    }

    func testVerifierFallsBackToMockWhileEndpointMissing() async throws {
        struct Missing: IAPVerifying {
            func submit(signedTransaction: String, appAccountToken: UUID) async throws -> EntitlementsResponse { throw APIError.notAvailable }
        }
        let r = try await FallbackIAPVerifier(live: Missing()).submit(signedTransaction: "jws", appAccountToken: UUID())
        XCTAssertEqual(r.entitlements, ["pro"])
    }

    func testLiveVerifierRequestShape() throws {
        let req = try APIClient(baseURL: URL(string: "https://example.com")!, tokenProvider: { nil })
            .request(for: Endpoint(path: "/api/iap/apple", method: .post, body: ["signed_transaction": "a", "app_account_token": "b"]))
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.path, "/api/iap/apple")
    }
}
