import UIKit
import UserNotifications

/// UIKit hooks SwiftUI doesn't expose: the APNs token callbacks, and the
/// notification-center delegate that routes push taps (#137 — without it a tap
/// just foregrounded the app and foreground pushes showed no banner).
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        FeedPlayer.configureAudioSession()
        SoundFontStore.shared.preload()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in await PushManager.shared.didRegister(deviceToken: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // Expected on the simulator and in builds signed without the Push entitlement.
    }

    /// Foreground pushes still show a banner (plus list/sound/badge) instead of arriving silently.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound, .badge]
    }

    /// A tap routes the payload's `link` through the app's DeepLinkRouter (via PushLinkStore,
    /// which also covers the cold-launch case where the UI doesn't exist yet).
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse) async {
        let userInfo = response.notification.request.content.userInfo
        let url = await MainActor.run {
            PushPayload.linkURL(from: userInfo, fallbackHandle: AuthStore.shared.me?.handle)
        }
        guard let url else { return }
        await MainActor.run { PushLinkStore.shared.enqueue(url) }
    }
}
