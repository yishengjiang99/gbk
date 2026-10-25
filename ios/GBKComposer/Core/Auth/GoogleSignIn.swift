import Foundation

/// Stub: Google Sign-In SDK is not integrated yet.
enum GoogleSignIn {
    enum Failure: Error { case notImplemented }

    @MainActor
    static func signIn(auth: AuthStore) async throws {
        throw Failure.notImplemented
    }
}
