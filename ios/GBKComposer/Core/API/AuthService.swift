import Foundation

/// The specced-but-unbuilt iOS-1 / P5 endpoints (native auth, refresh, logout, web-view code, DELETE /api/me, push).
/// `LiveAuthService` calls the real routes; `MockAuthService` is an in-memory stand-in for tests and previews.
/// `AuthServices.current` is the live service, which falls back to the mock's no-op behaviour for the
/// harmless calls (logout, push, web-code) while those routes 404. Identity calls (sign-in, refresh, delete)
/// never fall back: they throw `APIError.notAvailable` rather than fake a session against prod.
protocol AuthServicing {
    func exchangeApple(identityToken: String, nonce: String, displayName: String?) async throws -> TokenPair
    func exchangeGoogle(idToken: String) async throws -> TokenPair
    func refresh(refreshToken: String) async throws -> TokenPair
    func logout() async throws
    /// nil = no handoff available; load /studio directly.
    func webSessionURL(returnPath: String) async throws -> URL?
    func deleteAccount() async throws
    func registerPush(installId: String, token: String, environment: String) async throws
    func unregisterPush(installId: String) async throws
}

enum AuthServices {
    static var current: AuthServicing = LiveAuthService(client: .shared)
}

struct LiveAuthService: AuthServicing {
    let client: APIClient
    private let fallback = MockAuthService()

    func exchangeApple(identityToken: String, nonce: String, displayName: String?) async throws -> TokenPair {
        try await client.send(Endpoints.appleExchange(identityToken: identityToken, nonce: nonce, displayName: displayName), as: TokenPair.self)
    }
    func exchangeGoogle(idToken: String) async throws -> TokenPair {
        try await client.send(Endpoints.googleExchange(idToken: idToken), as: TokenPair.self)
    }
    func refresh(refreshToken: String) async throws -> TokenPair {
        try await client.send(Endpoints.refresh(refreshToken), as: TokenPair.self)
    }
    func logout() async throws {
        if try await client.sendIfAvailable(Endpoints.logout, as: OKResult.self) == nil { try await fallback.logout() }
    }
    func webSessionURL(returnPath: String) async throws -> URL? {
        guard AuthStore.currentAccessToken() != nil,
              let code = try await client.sendIfAvailable(Endpoints.webCode, as: WebCode.self) else { return nil }
        return try client.url(for: Endpoints.webCodeRedeemPath(code: code.code, returnPath: returnPath))
    }
    func deleteAccount() async throws {
        _ = try await client.send(Endpoints.deleteMe, as: OKResult.self)
    }
    func registerPush(installId: String, token: String, environment: String) async throws {
        if try await client.sendIfAvailable(Endpoints.pushRegister(installId: installId, token: token, environment: environment), as: OKResult.self) == nil {
            try await fallback.registerPush(installId: installId, token: token, environment: environment)
        }
    }
    func unregisterPush(installId: String) async throws {
        if try await client.sendIfAvailable(Endpoints.pushUnregister(installId: installId), as: OKResult.self) == nil {
            try await fallback.unregisterPush(installId: installId)
        }
    }
}

/// In-memory mock matching the doc's response shapes.
final class MockAuthService: AuthServicing {
    private(set) var registeredPush: [String: String] = [:]
    private(set) var deleted = false
    private var counter = 0
    let me = Me(id: "mock-user", handle: "mockuser", displayName: "Mock User", avatarUrl: nil, songCount: 0,
                ratingAvg: nil, createdAt: 0, dmPolicy: "all", handleChanged: false, isAdmin: false)

    private func pair() -> TokenPair {
        counter += 1
        return TokenPair(accessToken: "mock-access-\(counter)", tokenType: "Bearer", expiresIn: 3600,
                         refreshToken: "mock-refresh-\(counter)", me: me)
    }

    func exchangeApple(identityToken: String, nonce: String, displayName: String?) async throws -> TokenPair { pair() }
    func exchangeGoogle(idToken: String) async throws -> TokenPair { pair() }
    func refresh(refreshToken: String) async throws -> TokenPair {
        guard refreshToken.hasPrefix("mock-refresh-") else { throw APIError.unauthenticated }
        return pair()
    }
    func logout() async throws {}
    func webSessionURL(returnPath: String) async throws -> URL? {
        URL(string: "https://compose.grepawk.com/api/auth/web-code/redeem?code=mock&return=\(returnPath)")
    }
    func deleteAccount() async throws { deleted = true }
    func registerPush(installId: String, token: String, environment: String) async throws { registeredPush[installId] = token }
    func unregisterPush(installId: String) async throws { registeredPush[installId] = nil }
}
