import SwiftUI

struct InboxView: View {
    @EnvironmentObject private var auth: AuthStore
    @Environment(\.requestSignIn) private var requestSignIn

    var body: some View {
        NavigationStack {
            Group {
                if auth.isLinkedAccount { // guests cannot send or receive DMs (GUEST_LIMITED)
                    ContentUnavailableView("No messages yet", systemImage: "tray",
                                           description: Text("Conversations about your songs will show up here."))
                } else {
                    // Normally unreachable: the tab itself is gated (RootTabView). No standalone sign-in button.
                    SignedOutState(icon: "bubble.left.and.bubble.right",
                                   title: "Messages live here",
                                   message: "Sign in with Apple or Google to chat with other composers.")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Inbox")
        }
    }
}

/// Friendly signed-out placeholder (no sign-in button: sign-in opens only from gated actions).
struct SignedOutState: View {
    let icon: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: icon).font(.system(size: 48)).foregroundStyle(Theme.accent)
            Text(title).font(.title3.bold()).foregroundStyle(Theme.text)
            Text(message).font(.subheadline).multilineTextAlignment(.center).foregroundStyle(Theme.textSecondary)
        }
        .padding(32)
    }
}
