import Foundation
import Security

/// Minimal Keychain wrapper for generic-password items.
enum Keychain {
    static let service = "com.grepawk.gbkcomposer"

    static func set(_ value: String?, for key: String) {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                   kSecAttrService as String: service,
                                   kSecAttrAccount as String: key]
        SecItemDelete(base as CFDictionary)
        guard let value, let data = value.data(using: .utf8) else { return }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }

    static func get(_ key: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: service,
                                kSecAttrAccount as String: key,
                                kSecReturnData as String: true,
                                kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

@MainActor
final class AuthStore: ObservableObject {
    static let shared = AuthStore()
    nonisolated static let accessKey = "auth.accessToken"
    nonisolated static let refreshKey = "auth.refreshToken"

    @Published private(set) var accessToken: String?
    @Published private(set) var me: Me?
    var isSignedIn: Bool { accessToken != nil }

    init() { accessToken = Keychain.get(Self.accessKey) }

    nonisolated static func currentAccessToken() -> String? { Keychain.get(accessKey) }
    nonisolated static func currentRefreshToken() -> String? { Keychain.get(refreshKey) }

    func store(_ pair: TokenPair) {
        Keychain.set(pair.accessToken, for: Self.accessKey)
        if let r = pair.refreshToken { Keychain.set(r, for: Self.refreshKey) }
        accessToken = pair.accessToken
        if let m = pair.me { me = m }
    }

    /// `GET /api/me` (live). Signs out locally on 401.
    func loadMe(client: APIClient = .shared) async {
        guard isSignedIn else { return }
        do { me = try await client.send(Endpoints.me, as: Me.self) }
        catch APIError.unauthenticated { clearLocal() }
        catch {}
    }

    /// `POST /api/auth/logout` (iOS-1; ignored while 404), then local clear.
    func signOut() async {
        try? await AuthServices.current.logout()
        await PushManager.shared.disable()
        clearLocal()
    }

    /// `DELETE /api/me` (iOS-1). Throws `APIError.notAvailable` until it ships.
    func deleteAccount() async throws {
        try await AuthServices.current.deleteAccount()
        await PushManager.shared.disable()
        clearLocal()
    }

    func clearLocal() {
        Keychain.set(nil, for: Self.accessKey)
        Keychain.set(nil, for: Self.refreshKey)
        accessToken = nil
        me = nil
    }
}
