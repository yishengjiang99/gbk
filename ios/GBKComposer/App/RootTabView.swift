import SwiftUI

enum AppTab: Hashable { case feed, create, inbox, profile }

struct RootTabView: View {
    @EnvironmentObject private var router: DeepLinkRouter
    @EnvironmentObject private var auth: AuthStore
    @Environment(\.requestSignIn) private var requestSignIn
    @ObservedObject private var store = PurchaseStore.shared

    /// Profile and Inbox are gated (feed-design.md): selecting one signed out (or as a guest) opens the sign-in sheet
    /// and stays on the current tab; after sign-in the tab opens.
    private var selection: Binding<AppTab> {
        Binding(get: { router.selectedTab }, set: { tab in
            guard Self.isGated(tab), !auth.isLinkedAccount else { router.selectedTab = tab; return }
            requestSignIn(tab == .inbox ? "Sign in to send and receive messages." : "Sign in to see your profile and songs.",
                          need: .linkedAccount) { router.selectedTab = tab }
        })
    }

    static func isGated(_ tab: AppTab) -> Bool { tab == .inbox || tab == .profile }

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
        .sheet(isPresented: $store.showPaywall) { PaywallView(store: store) }
    }
}
