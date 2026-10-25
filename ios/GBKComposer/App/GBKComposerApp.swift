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
                .onAppear { router.handleLaunchArguments() }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL { router.handle(url) }
                }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await PushManager.shared.refresh() } }
        }
    }
}
