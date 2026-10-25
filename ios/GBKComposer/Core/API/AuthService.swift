import Foundation

/// Native auth, refresh, logout, web-view code, DELETE /api/me and push (server/src/routes/native.ts, live on prod).
/// `LiveAuthService` (the default) calls them directly; `MockAuthService` is an in-memory stand-in for tests and previews.
/// `POST /api/auth/apple` answers 503 APPLE_UNAVAILABLE until the server is configured; that surfaces as
/// `APIError.notAvailable` ("not available yet").
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
    /// Guest account (`POST /api/auth/anonymous`; specced by GBK Social, 404 → notAvailable until deployed).
    func registerAnonymous(deviceID: String, username: String) async throws -> TokenPair
}

enum AuthServices {
    static var current: AuthServicing = LiveAuthService(client: .shared)
}

struct LiveAuthService: AuthServicing {
    let client: APIClient

    func exchangeApple(identityToken: String, nonce: String, displayName: String?) async throws -> TokenPair {
        try await client.send(Endpoints.appleExchange(identityToken: identityToken, nonce: nonce, displayName: displayName), as: TokenPair.self)
    }
    func exchangeGoogle(idToken: String) async throws -> TokenPair {
        try await client.send(Endpoints.googleExchange(idToken: idToken), as: TokenPair.self)
    }
    func refresh(refreshToken: String) async throws -> TokenPair {
        try await client.send(Endpoints.refresh(refreshToken), as: TokenPair.self)
    }
    /// Revokes the presented access token and the stored refresh token.
    func logout() async throws {
        _ = try await client.send(Endpoints.logout(refreshToken: AuthStore.currentRefreshToken()), as: OKResult.self)
    }
    /// One-time code (bearer, 60 s) → redeem URL that sets the cookie session in the WKWebView and 302s to `returnPath`.
    func webSessionURL(returnPath: String) async throws -> URL? {
        guard AuthStore.currentAccessToken() != nil else { return nil }
        let code = try await client.send(Endpoints.webCode, as: WebCode.self)
        return try client.url(for: Endpoints.webCodeRedeemPath(code: code.code, returnPath: returnPath))
    }
    func deleteAccount() async throws {
        _ = try await client.send(Endpoints.deleteMe, as: OKResult.self)
    }
    func registerPush(installId: String, token: String, environment: String) async throws {
        _ = try await client.send(Endpoints.pushRegister(installId: installId.lowercased(), token: token, environment: environment), as: OKResult.self)
    }
    func unregisterPush(installId: String) async throws {
        _ = try await client.send(Endpoints.pushUnregister(installId: installId.lowercased()), as: PushUnregisterResult.self)
    }
    func registerAnonymous(deviceID: String, username: String) async throws -> TokenPair {
        try await client.send(Endpoints.anonymous(deviceID: deviceID, username: username), as: TokenPair.self)
    }
}

/// In-memory mock matching the doc's response shapes.
class MockAuthService: AuthServicing {
    private(set) var registeredPush: [String: String] = [:]
    private(set) var deleted = false
    private var counter = 0
    let me = Me(id: "mock-user", handle: "mockuser", displayName: "Mock User", avatarUrl: nil, songCount: 0,
                ratingAvg: nil, createdAt: 0, dmPolicy: "all", handleChanged: false, isAdmin: false, provider: "google", isGuest: false)

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
    /// Handles in `takenHandles` answer 409 HANDLE_TAKEN like the proposed server route.
    var takenHandles: Set<String> = []
    func registerAnonymous(deviceID: String, username: String) async throws -> TokenPair {
        let handle = AnonymousIdentity.handle(for: username), displayName = username
        if takenHandles.contains(handle) { throw APIError.badStatus(409, APIErrorBody(code: "HANDLE_TAKEN", message: "taken")) }
        counter += 1
        return TokenPair(accessToken: "mock-anon-\(counter)", tokenType: "Bearer", expiresIn: 3600, refreshToken: "mock-refresh-\(counter)",
                         me: Me(id: "anon-\(deviceID)", handle: handle, displayName: displayName, avatarUrl: nil, songCount: 0,
                                ratingAvg: nil, createdAt: 0, dmPolicy: "all", handleChanged: false, isAdmin: false, provider: "guest", isGuest: true))
    }
}
