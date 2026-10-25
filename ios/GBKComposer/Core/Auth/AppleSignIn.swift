import AuthenticationServices
import Foundation

/// Stub: wires Sign in with Apple's button result to AuthStore. Server token exchange comes later.
enum AppleSignIn {
    static func configure(_ request: ASAuthorizationAppleIDRequest) {
        request.requestedScopes = [.fullName, .email]
    }

    @MainActor
    static func handle(_ result: Result<ASAuthorization, Error>, auth: AuthStore) {
        guard case .success(let authorization) = result,
              let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken,
              let idToken = String(data: tokenData, encoding: .utf8) else { return }
        // TODO: POST idToken to the server and store the returned session token instead.
        auth.store(accessToken: idToken, refreshToken: nil)
    }
}
