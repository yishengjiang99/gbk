import XCTest
@testable import GBKComposer

/// Server verdicts the purchase path acts on (#142): finish only on grant or permanent refusal.
@MainActor
final class PurchaseVerifyTests: XCTestCase {
    struct Scripted: IAPVerifying {
        let result: Result<EntitlementsResponse, Error>
        func submit(signedTransaction: String, appAccountToken: UUID) async throws -> EntitlementsResponse { try result.get() }
    }

    private func outcome(_ r: Result<EntitlementsResponse, Error>) async -> PurchaseStore.VerifyOutcome {
        await PurchaseStore(verifier: Scripted(result: r), accountId: { nil }, serverPro: { false }, serverMe: { nil })
            .verify(jws: "jws", token: UUID())
    }

    func testGrantFinishes() async {
        let o = await outcome(.success(EntitlementsResponse(entitlements: ["pro"], expiresAt: nil)))
        XCTAssertEqual(o, .granted); XCTAssertTrue(o.shouldFinish)
    }

    func testNoGrantStaysUnfinished() async {
        let o = await outcome(.success(EntitlementsResponse(entitlements: [], expiresAt: nil)))
        XCTAssertEqual(o, .notGranted); XCTAssertFalse(o.shouldFinish)
    }

    func testOwnedByOtherIsRefusedAndFinished() async {
        let o = await outcome(.failure(APIError.badStatus(409, APIErrorBody(code: "IAP_OWNED_BY_OTHER", message: nil))))
        guard case .refused = o else { return XCTFail("\(o)") }
        XCTAssertTrue(o.shouldFinish)
        XCTAssertEqual(PurchaseStore.restoreMessage(isPro: true, outcomes: [.granted, o]), PurchaseStore.refusalMessage(code: 409, body: nil))
    }

    func testTransientStaysUnfinished() async {
        for e: Error in [URLError(.notConnectedToInternet), APIError.badStatus(500, nil), APIError.unauthenticated,
                         APIError.rateLimited(retryAfter: nil, nil), APIError.notAvailable] {
            let o = await outcome(.failure(e))
            XCTAssertEqual(o, .transient, "\(e)"); XCTAssertFalse(o.shouldFinish)
        }
        XCTAssertNotEqual(PurchaseStore.restoreMessage(isPro: true, outcomes: [.transient]), "Purchases restored.")
    }

    func testRevokedOrExpiredFinishesSilently() {
        let now = Date()
        XCTAssertTrue(PurchaseStore.isInactive(revoked: now.addingTimeInterval(-60), expires: nil, now: now))
        XCTAssertTrue(PurchaseStore.isInactive(revoked: nil, expires: now.addingTimeInterval(-1), now: now))
        XCTAssertFalse(PurchaseStore.isInactive(revoked: nil, expires: now.addingTimeInterval(3600), now: now))
        XCTAssertFalse(PurchaseStore.isInactive(revoked: nil, expires: nil, now: now))
    }
}
