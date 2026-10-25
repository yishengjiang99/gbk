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
                    SignedOutState(icon: "bubble.left.and.bubble.right",
                                   title: "Messages live here",
                                   message: auth.isSignedIn ? "You're browsing as \(auth.me?.displayName ?? auth.anonymousUsername). Sign in with Apple or Google to chat with other composers." : "Browse and listen as much as you like. Sign in when you want to chat with other composers.",
                                   action: "Sign in to message") { requestSignIn("Sign in to send and receive messages.") }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Inbox")
        }
    }
}

/// Friendly signed-out placeholder with one sign-in button.
struct SignedOutState: View {
    let icon: String
    let title: String
    let message: String
    let action: String
    let onSignIn: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: icon).font(.system(size: 48)).foregroundStyle(Theme.accent)
            Text(title).font(.title3.bold()).foregroundStyle(Theme.text)
            Text(message).font(.subheadline).multilineTextAlignment(.center).foregroundStyle(Theme.textSecondary)
            Button(action: onSignIn) { Text(action).frame(maxWidth: 260, minHeight: 44) }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .foregroundStyle(Theme.onAccent)
        }
        .padding(32)
    }
}
