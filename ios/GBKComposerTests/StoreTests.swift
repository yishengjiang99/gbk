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

    func testLiveVerifierIsDefaultAndMeDecodesPro() throws {
        XCTAssertTrue(IAPVerificationServices.current is LiveIAPVerifier)
        let json = #"{"id":"a","handle":"h","pro":true,"pro_source":"apple","pro_expires_at":4102444800000,"pro_environment":"Sandbox"}"#
        let me = try APIClient.makeDecoder().decode(Me.self, from: Data(json.utf8))
        XCTAssertEqual(me.proSource, "apple"); XCTAssertEqual(me.proEnvironment, "Sandbox")
        XCTAssertTrue(me.hasActivePro())
        XCTAssertFalse(me.hasActivePro(now: Date(timeIntervalSince1970: 4_102_444_800_001 / 1000)))
        let old = try APIClient.makeDecoder().decode(Me.self, from: Data(#"{"id":"a","handle":"h"}"#.utf8))
        XCTAssertFalse(old.hasActivePro())
        let r = try APIClient.makeDecoder().decode(EntitlementsResponse.self, from: Data(#"{"entitlements":["pro"],"expires_at":null,"product_id":"lifetime","environment":"Production"}"#.utf8))
        XCTAssertEqual(r.entitlements, ["pro"]); XCTAssertNil(r.expiresAt); XCTAssertEqual(r.environment, "Production")
    }

    func testLiveVerifierRequestShape() throws {
        let req = try APIClient(baseURL: URL(string: "https://example.com")!, tokenProvider: { nil })
            .request(for: Endpoint(path: "/api/iap/apple", method: .post, body: ["signed_transaction": "a", "app_account_token": "b"]))
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.path, "/api/iap/apple")
    }

    @MainActor
    func testProStatusSourceAndGatedPaywallSkipsPro() {
        let stripe = Me(id: "a", handle: "h", displayName: nil, avatarUrl: nil, songCount: nil, ratingAvg: nil, createdAt: nil,
                        dmPolicy: nil, handleChanged: nil, isAdmin: nil, provider: nil, isGuest: nil,
                        pro: true, proSource: "stripe", proExpiresAt: 4_102_444_800_000)
        let s = ProStatus.resolve(localPro: false, localExpiry: nil, me: stripe)
        XCTAssertEqual(s.source, .stripe)
        XCTAssertEqual(s.renews, Date(timeIntervalSince1970: 4_102_444_800))
        var lifetime = stripe; lifetime.proExpiresAt = nil
        XCTAssertEqual(ProStatus.resolve(localPro: false, localExpiry: nil, me: lifetime).source, .lifetime)
        XCTAssertEqual(ProStatus.resolve(localPro: true, localExpiry: Date(timeIntervalSince1970: 1), me: nil).source, .apple)

        let store = PurchaseStore(verifier: MockIAPVerifier(), accountId: { nil }, serverPro: { true }, serverMe: { stripe })
        store.recompute()
        store.presentPaywall(reason: "studio_link")
        XCTAssertFalse(store.showPaywall)
        store.presentPaywall(reason: "profile")
        XCTAssertTrue(store.showPaywall)
        XCTAssertEqual(store.proStatus?.source, .stripe)
    }
}
