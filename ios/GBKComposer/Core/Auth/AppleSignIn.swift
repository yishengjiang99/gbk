import AuthenticationServices
import CryptoKit
import Foundation

/// Sign in with Apple → `POST /api/auth/apple` (iOS-1). Until that route ships, sign-in reports "not available".
@MainActor
enum AppleSignIn {
    private static var rawNonce: String?

    static func configure(_ request: ASAuthorizationAppleIDRequest) {
        let nonce = UUID().uuidString + UUID().uuidString
        rawNonce = nonce
        request.requestedScopes = [.fullName, .email]
        request.nonce = sha256(nonce)
    }

    static func handle(_ result: Result<ASAuthorization, Error>, auth: AuthStore,
                       client: APIClient = .shared) async throws {
        let authorization = try result.get()
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken,
              let idToken = String(data: tokenData, encoding: .utf8),
              let nonce = rawNonce else { throw APIError.invalidURL }
        let name = credential.fullName.flatMap { PersonNameComponentsFormatter().string(from: $0) }
        let pair = try await AuthServices.current.exchangeApple(
            identityToken: idToken, nonce: nonce, displayName: (name?.isEmpty ?? true) ? nil : name)
        auth.store(pair, anonymous: false)
        await auth.loadMe(client: client)
    }

    static func sha256(_ s: String) -> String {
        SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
