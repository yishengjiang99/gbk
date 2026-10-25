import SwiftUI

enum AppTab: Hashable { case feed, create, inbox, profile }

struct RootTabView: View {
    @EnvironmentObject private var router: DeepLinkRouter

    var body: some View {
        TabView(selection: $router.selectedTab) {
            FeedView()
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
    }
}
