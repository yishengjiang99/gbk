import SwiftUI

struct ProfileView: View {
    @EnvironmentObject private var auth: AuthStore

    var body: some View {
        NavigationStack {
            Group {
                if auth.isSignedIn {
                    VStack(spacing: 16) {
                        Image(systemName: "person.crop.circle.fill").font(.system(size: 72)).foregroundStyle(Theme.accent)
                        Text("Your songs will appear here.").foregroundStyle(.secondary)
                        Button("Sign out", role: .destructive) { auth.signOut() }
                    }
                } else {
                    SignInView(reason: "Sign in to see your profile and songs.")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Profile")
        }
    }
}
