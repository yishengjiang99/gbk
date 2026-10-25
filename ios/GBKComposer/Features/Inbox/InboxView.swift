import SwiftUI

struct InboxView: View {
    @EnvironmentObject private var auth: AuthStore

    var body: some View {
        NavigationStack {
            Group {
                if auth.isSignedIn {
                    ContentUnavailableView("No messages yet", systemImage: "tray",
                                           description: Text("Conversations about your songs will show up here."))
                } else {
                    SignInView(reason: "Sign in to see your messages.")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Inbox")
        }
    }
}
