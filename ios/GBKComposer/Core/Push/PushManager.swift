// Ported from yishengjiang99/earsheet Sources/App/PushManager.swift.
import Foundation
import UIKit
import UserNotifications

/// Notification authorization, seam for tests.
protocol NotificationAuthorizing {
    func authorizationStatus() async -> UNAuthorizationStatus
    func requestAuthorization() async throws -> Bool
}

struct SystemNotificationCenter: NotificationAuthorizing {
    func authorizationStatus() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }
    func requestAuthorization() async throws -> Bool {
        try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
    }
}

/// Stable per-install identifier.
enum InstallIdentity {
    static let key = "install.id"
    static var installIdString: String {
        if let id = UserDefaults.standard.string(forKey: key) { return id }
        let id = UUID().uuidString
        UserDefaults.standard.set(id, forKey: key)
        return id
    }
}

/// APNs registration via `AuthServicing` (`POST /api/push/register` / `unregister`, live).
/// Never prompts on launch; the prompt appears only via `enable()` (an explicit user action).
@MainActor
final class PushManager: ObservableObject {
    static let shared = PushManager()

    @Published private(set) var status: UNAuthorizationStatus = .notDetermined
    @Published private(set) var enabledInApp: Bool

    static let enabledKey = "push.enabled"
    static let tokenKey = "push.registeredToken"

    private let center: NotificationAuthorizing
    private let service: AuthServicing
    private let defaults: UserDefaults
    private let registerRemote: () -> Void
    private let unregisterRemote: () -> Void

    init(center: NotificationAuthorizing = SystemNotificationCenter(),
         service: AuthServicing = AuthServices.current,
         defaults: UserDefaults = .standard,
         registerRemote: @escaping () -> Void = { UIApplication.shared.registerForRemoteNotifications() },
         unregisterRemote: @escaping () -> Void = { UIApplication.shared.unregisterForRemoteNotifications() }) {
        self.center = center
        self.service = service
        self.defaults = defaults
        self.registerRemote = registerRemote
        self.unregisterRemote = unregisterRemote
        self.enabledInApp = defaults.bool(forKey: Self.enabledKey)
    }

    static var apnsEnvironment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    var isAllowedBySystem: Bool {
        status == .authorized || status == .provisional || status == .ephemeral
    }

    func refresh() async {
        status = await center.authorizationStatus()
        // Register only after sign-in (never for signed-out or anonymous installs).
        if enabledInApp && isAllowedBySystem && AuthStore.shared.isLinkedAccount { registerRemote() }
    }

    @discardableResult
    func enable() async -> Bool {
        var s = await center.authorizationStatus()
        if s == .notDetermined {
            _ = try? await center.requestAuthorization()
            s = await center.authorizationStatus()
        }
        status = s
        enabledInApp = isAllowedBySystem
        defaults.set(enabledInApp, forKey: Self.enabledKey)
        if enabledInApp { registerRemote() }
        return enabledInApp
    }

    func disable() async {
        enabledInApp = false
        defaults.set(false, forKey: Self.enabledKey)
        unregisterRemote()
        await unregisterFromServer()
    }

    /// Sign-out: stop pushes for this install on the server (needs the bearer, so call before logout)
    /// but keep the user's toggle so the next sign-in re-registers.
    func signedOut() async {
        await unregisterFromServer()
    }

    /// After sign-in: register if the user already allowed notifications and left the toggle on.
    func signedIn() async {
        defaults.removeObject(forKey: Self.tokenKey)
        await refresh()
    }

    private func unregisterFromServer() async {
        guard defaults.string(forKey: Self.tokenKey) != nil else { return }
        try? await service.unregisterPush(installId: InstallIdentity.installIdString)
        defaults.removeObject(forKey: Self.tokenKey)
    }

    func didRegister(deviceToken: Data) async {
        guard enabledInApp, AuthStore.shared.isLinkedAccount else { return }
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        let installId = InstallIdentity.installIdString
        do {
            try await service.registerPush(installId: installId, token: hex, environment: Self.apnsEnvironment)
            defaults.set(hex, forKey: Self.tokenKey)
            // Server upserts by installId, so a rotated token replaces the previous one.
        } catch {
            // Retried on the next foreground via refresh().
        }
    }
}
