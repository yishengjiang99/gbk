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
    static let accessKey = "auth.accessToken"
    static let refreshKey = "auth.refreshToken"

    @Published private(set) var accessToken: String?
    var isSignedIn: Bool { accessToken != nil }

    init() { accessToken = Keychain.get(Self.accessKey) }

    /// Thread-safe read for APIClient.
    nonisolated static func currentAccessToken() -> String? { Keychain.get(accessKey) }

    func store(accessToken: String, refreshToken: String?) {
        Keychain.set(accessToken, for: Self.accessKey)
        Keychain.set(refreshToken, for: Self.refreshKey)
        self.accessToken = accessToken
    }

    func signOut() {
        Keychain.set(nil, for: Self.accessKey)
        Keychain.set(nil, for: Self.refreshKey)
        accessToken = nil
    }
}
