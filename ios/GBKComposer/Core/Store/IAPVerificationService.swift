import Foundation

/// Server response after it verifies an App Store signed transaction.
struct EntitlementsResponse: Codable, Equatable {
    let entitlements: [String]
    let expiresAt: Int64?
}

/// Grants the entitlement server-side from a StoreKit 2 signed transaction (JWS).
protocol IAPVerifying {
    func submit(signedTransaction: String, appAccountToken: UUID) async throws -> EntitlementsResponse
}

/// `POST /api/iap/apple {signed_transaction, app_account_token}` → `{entitlements, expires_at}`.
/// Not deployed yet (owned by GBK Social, see docs/asc/iap.md); `IAPVerificationServices.current`
/// falls back to the mock on 404 so purchases still unlock Pro locally.
struct LiveIAPVerifier: IAPVerifying {
    var client: APIClient = .shared
    func submit(signedTransaction: String, appAccountToken: UUID) async throws -> EntitlementsResponse {
        try await client.send(Endpoint(path: "/api/iap/apple", method: .post,
                                       body: ["signed_transaction": signedTransaction,
                                              "app_account_token": appAccountToken.uuidString.lowercased()]),
                              as: EntitlementsResponse.self)
    }
}

/// Local stand-in: trusts StoreKit's on-device verification and returns `pro`.
struct MockIAPVerifier: IAPVerifying {
    func submit(signedTransaction: String, appAccountToken: UUID) async throws -> EntitlementsResponse {
        EntitlementsResponse(entitlements: [StoreCatalog.proEntitlement], expiresAt: nil)
    }
}

/// Tries the live endpoint, falls back to the mock while it 404s.
struct FallbackIAPVerifier: IAPVerifying {
    var live: IAPVerifying = LiveIAPVerifier()
    var mock: IAPVerifying = MockIAPVerifier()
    func submit(signedTransaction: String, appAccountToken: UUID) async throws -> EntitlementsResponse {
        do { return try await live.submit(signedTransaction: signedTransaction, appAccountToken: appAccountToken) }
        catch APIError.notAvailable { return try await mock.submit(signedTransaction: signedTransaction, appAccountToken: appAccountToken) }
    }
}

enum IAPVerificationServices {
    static var current: IAPVerifying = FallbackIAPVerifier()
}

/// Stable per-account UUID for `appAccountToken`. Uses the account id when it is a UUID (guest and
/// signed-in accounts), otherwise a random install UUID kept in the Keychain.
enum AppAccountToken {
    static let key = "iap.appAccountToken"

    static func resolve(accountId: String?) -> UUID {
        if let accountId, let u = UUID(uuidString: accountId) { return u }
        if let s = Keychain.get(key), let u = UUID(uuidString: s) { return u }
        let u = UUID()
        Keychain.set(u.uuidString, for: key)
        return u
    }
}
