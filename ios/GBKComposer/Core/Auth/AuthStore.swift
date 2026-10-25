import Foundation
import Security

/// Minimal Keychain wrapper for generic-password items.
enum Keychain {
    static let service = "com.grepawk.gbk"
    /// Process-local mirror so values persist within a run when the Keychain is unavailable
    /// (unsigned simulator test host returns errSecMissingEntitlement).
    private static var memory: [String: String] = [:]
    private static let lock = NSLock()

    static func set(_ value: String?, for key: String) {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                   kSecAttrService as String: service,
                                   kSecAttrAccount as String: key]
        SecItemDelete(base as CFDictionary)
        lock.lock(); memory[key] = value; lock.unlock()
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
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else {
            lock.lock(); defer { lock.unlock() }
            return memory[key]
        }
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
    /// Any session (anonymous device account or Apple/Google). Gated actions need this.
    var isSignedIn: Bool { accessToken != nil }
    /// Session belongs to an Apple/Google-linked account (not the anonymous device account).
    var isLinkedAccount: Bool { isSignedIn && !(me?.isGuest ?? isAnonymousSession) }
    @Published private(set) var isAnonymousSession = UserDefaults.standard.bool(forKey: AuthStore.anonymousFlagKey)
    nonisolated static let anonymousFlagKey = "auth.anonymousSession"
    /// The install's two-word username, shown on Profile while signed out or anonymous.
    var anonymousUsername: String { AnonymousIdentity.username }

    init() { accessToken = Keychain.get(Self.accessKey) }

    nonisolated static func currentAccessToken() -> String? { Keychain.get(accessKey) }
    nonisolated static func currentRefreshToken() -> String? { Keychain.get(refreshKey) }

    /// Launch: make sure the install has an anonymous identity, and (when the server supports it) an anonymous
    /// session so rate/comment work without Apple/Google. On 409 HANDLE_TAKEN pick a different two-word name.
    /// Until GBK Social ships `POST /api/auth/anonymous` this ends at notAvailable and gated actions prompt sign-in.
    func ensureAnonymousSession(service: AuthServicing = AuthServices.current) async {
        var name = AnonymousIdentity.username
        guard !isSignedIn else { return }
        var tried: Set<String> = []
        for _ in 0..<5 {
            tried.insert(name)
            do {
                let pair = try await service.registerAnonymous(deviceID: AnonymousIdentity.deviceID, username: name)
                store(pair, anonymous: true)
                return
            } catch APIError.badStatus(let code, _) where code == 409 || code == 422 {
                // 409 HANDLE_TAKEN / 422 INVALID_USERNAME (blocklisted word): new two-word combo, never digits.
                name = AnonymousIdentity.replaceUsername(excluding: tried)
            } catch {
                return // not available yet / offline: stay signed out
            }
        }
    }

    /// Refresh keeps the current kind unless the server says otherwise.
    func store(_ pair: TokenPair) { store(pair, anonymous: pair.me?.isGuest ?? isAnonymousSession) }

    /// Apple/Google exchanges send the current (anonymous) bearer, so the server can link/upgrade that account.
    func store(_ pair: TokenPair, anonymous: Bool) {
        let wasLinked = isLinkedAccount
        isAnonymousSession = anonymous
        UserDefaults.standard.set(anonymous, forKey: Self.anonymousFlagKey)
        Keychain.set(pair.accessToken, for: Self.accessKey)
        if let r = pair.refreshToken { Keychain.set(r, for: Self.refreshKey) }
        accessToken = pair.accessToken
        if let m = pair.me { me = m }
        // Push registration only after a real (Apple/Google/reviewer) sign-in.
        if !anonymous && !wasLinked { Task { await PushManager.shared.signedIn() } }
    }

    /// `GET /api/me` (live). Signs out locally on 401.
    func loadMe(client: APIClient = .shared) async {
        guard isSignedIn else { return }
        do { me = try await client.send(Endpoints.me, as: Me.self) }
        catch APIError.unauthenticated { clearLocal() }
        catch {}
    }

    /// Unregister push, `POST /api/auth/logout` (revokes access + refresh), then clear the Keychain.
    func signOut() async {
        await PushManager.shared.signedOut()
        try? await AuthServices.current.logout()
        clearLocal()
    }

    /// `DELETE /api/me`: deletes the account, songs, comments, ratings, messages and devices.
    func deleteAccount() async throws {
        try await AuthServices.current.deleteAccount() // server also removes this user's push devices
        await PushManager.shared.disable()
        clearLocal()
    }

    func clearLocal() {
        isAnonymousSession = false
        UserDefaults.standard.set(false, forKey: Self.anonymousFlagKey)
        Keychain.set(nil, for: Self.accessKey)
        Keychain.set(nil, for: Self.refreshKey)
        accessToken = nil
        me = nil
    }
}
