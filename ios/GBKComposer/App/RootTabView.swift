import SwiftUI

enum AppTab: Hashable { case feed, create, inbox, profile }

struct RootTabView: View {
    @EnvironmentObject private var router: DeepLinkRouter
    @ObservedObject private var store = PurchaseStore.shared

    var body: some View {
        TabView(selection: $router.selectedTab) {
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
