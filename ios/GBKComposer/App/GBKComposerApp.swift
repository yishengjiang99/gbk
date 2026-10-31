import SwiftUI

@main
struct GBKComposerApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var auth = AuthStore.shared
    @StateObject private var router = DeepLinkRouter()
    @Environment(\.scenePhase) private var scenePhase

    /// Unit tests run inside this app; launch side effects (guest registration writes Keychain) would race them.
    static let isUnitTestHost = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil

    var body: some Scene {
        WindowGroup {
            RootTabView()
                .signInPrompting() // must sit inside .environmentObject(auth): SignInPrompt reads AuthStore
                .environmentObject(auth)
                .environmentObject(router)
                .tint(Theme.accent)
                .task { if !Self.isUnitTestHost { await auth.ensureAnonymousSession() } }
                .onOpenURL { router.handle($0) }
                .task { PurchaseStore.shared.start() }
                .task { if !Self.isUnitTestHost { PaywallTriggerWatcher.shared.start() } }
                // Background homr model warmup for Scan (Music Reader parity): detached inside
                // `start()`, never on the main thread; a scan arriving mid-warmup attaches to it.
                .task { if !Self.isUnitTestHost { ScanModelWarmup.shared.start() } }
                .onAppear { router.handleLaunchArguments() }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL { router.handle(url) }
                }
        }
        .onChange(of: scenePhase) { _, phase in
            // Foreground is a paywall watch point (#123): work in the web Studio (another app, a
            // browser) may have flipped eligibility, so refresh `/api/me` for the watcher.
            if phase == .active {
                Task { await PushManager.shared.refresh(); await auth.loadMe() }
                // Silent Scan model re-warm kick (GBK addition; Music Reader has none): no-op
                // when ready or already warming, restarts after failure or a memory-warning
                // release, so a later scan doesn't pay the cold load.
                if !Self.isUnitTestHost { ScanModelWarmup.shared.startOnForeground() }
            }
            if phase == .background { BillingEventLogger.shared.suspend() }
        }
    }
}
