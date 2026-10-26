import SwiftUI

enum AppTab: Hashable { case feed, create, inbox, profile }

struct RootTabView: View {
    @EnvironmentObject private var router: DeepLinkRouter
    @EnvironmentObject private var auth: AuthStore
    @Environment(\.requestSignIn) private var requestSignIn
    @ObservedObject private var store = PurchaseStore.shared

    /// Only Inbox is gated (guests can't DM): selecting it without Apple/Google opens the sign-in sheet and stays on
    /// the current tab; after sign-in it opens. Profile is open to guests (Yisheng: shows the two-word name).
    private var selection: Binding<AppTab> {
        Binding(get: { router.selectedTab }, set: { tab in
            guard Self.isGated(tab), !auth.isLinkedAccount else { router.selectedTab = tab; return }
            requestSignIn("Sign in to send and receive messages.", need: .linkedAccount) { router.selectedTab = tab }
        })
    }

    static func isGated(_ tab: AppTab) -> Bool { tab == .inbox }

    var body: some View {
        TabView(selection: selection) {
            NavigationStack(path: $router.feedPath) {
                FeedView()
                    .toolbar(.hidden, for: .navigationBar)
                    .navigationDestination(for: String.self) { UserProfileView(handle: $0) }
            }
                .tabItem { Label("Feed", systemImage: "play.rectangle.on.rectangle") }
                .tag(AppTab.feed)
            StudioWebView()
                .tabItem { Label("Create", systemImage: "plus.circle.fill") }
                .tag(AppTab.create)
            InboxView()
                .tabItem { Label("Inbox", systemImage: "tray") }
                .tag(AppTab.inbox)
            ProfileView()
                .tabItem { Label("Profile", systemImage: "person.crop.circle") }
                .tag(AppTab.profile)
        }
        .sheet(isPresented: $store.showPaywall, onDismiss: { PaywallTriggerWatcher.shared.sheetDismissed() }) { PaywallView(store: store) }
        .onChange(of: router.selectedTab) { _, tab in
            // Studio open is a paywall watch point (#123): composing/exporting happened in the web
            // Studio since the last snapshot, so refresh `/api/me` and let the watcher evaluate.
            if tab == .create { Task { await auth.loadMe() } }
        }
    }
}
