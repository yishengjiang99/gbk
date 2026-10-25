import Foundation

/// Server response after it verifies an App Store signed transaction.
struct EntitlementsResponse: Codable, Equatable {
    let entitlements: [String]
    let expiresAt: Int64?
    var productId: String? = nil
    var environment: String? = nil
}

/// Grants the entitlement server-side from a StoreKit 2 signed transaction (JWS).
protocol IAPVerifying {
    func submit(signedTransaction: String, appAccountToken: UUID) async throws -> EntitlementsResponse
}

/// `POST /api/iap/apple {signed_transaction, app_account_token}` → `{entitlements, expires_at, product_id, environment}`
/// (live, docs/social-api.md). Bearer when signed in/guest; errors (400 INVALID_JWS…, 409 IAP_OWNED_BY_OTHER, 429) throw.
struct LiveIAPVerifier: IAPVerifying {
    var client: APIClient = .shared
    func submit(signedTransaction: String, appAccountToken: UUID) async throws -> EntitlementsResponse {
        try await client.send(Endpoint(path: "/api/iap/apple", method: .post,
                                       body: ["signed_transaction": signedTransaction,
                                              "app_account_token": appAccountToken.uuidString.lowercased()]),
                              as: EntitlementsResponse.self)
    }
}

/// Test/preview stand-in: trusts StoreKit's on-device verification and returns `pro`.
struct MockIAPVerifier: IAPVerifying {
    func submit(signedTransaction: String, appAccountToken: UUID) async throws -> EntitlementsResponse {
        EntitlementsResponse(entitlements: [StoreCatalog.proEntitlement], expiresAt: nil)
    }
}

enum IAPVerificationServices {
    static var current: IAPVerifying = LiveIAPVerifier()
}

/// Stable per-account UUID for `appAccountToken`. Uses the account id when it is a UUID (guest and
/// signed-in accounts), otherwise a random install UUID kept in the Keychain.
enum AppAccountToken {
    static let key = "iap.appAccountToken"

    static func resolve(accountId: String?) -> UUID {
        if let accountId, let u = UUID(uuidString: accountId) { return u }
        // Keychain first (survives reinstall); UserDefaults backs it up where the Keychain is unavailable (unsigned test host).
        if let s = Keychain.get(key) ?? UserDefaults.standard.string(forKey: key), let u = UUID(uuidString: s) { return u }
        let u = UUID()
        Keychain.set(u.uuidString, for: key)
        UserDefaults.standard.set(u.uuidString, forKey: key)
        return u
    }
}
