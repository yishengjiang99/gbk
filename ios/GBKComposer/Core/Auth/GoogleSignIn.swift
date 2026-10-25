import Foundation

/// Google Sign-In SDK is not integrated yet. Once it is, pass its idToken to
/// `POST /api/auth/google/native` (iOS-1) via `exchange(idToken:)`.
enum GoogleSignIn {
    @MainActor
    static func signIn(auth: AuthStore) async throws {
        throw APIError.notAvailable
    }

    @MainActor
    static func exchange(idToken: String, auth: AuthStore) async throws {
        let pair = try await AuthServices.current.exchangeGoogle(idToken: idToken)
        auth.store(pair)
    }
}
