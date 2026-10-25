import AuthenticationServices
import SwiftUI

/// The only sign-in UI: a sheet opened by a gated action (web SignInSheet, feed-design.md). There is no
/// standalone Sign in button anywhere. Layout follows prod: "Sign in" + close, the reason, Continue buttons,
/// Reviewer sign-in link, and "Guests can browse, play and read without an account."
struct SignInView: View {
    @EnvironmentObject private var auth: AuthStore
    var reason: String
    var onClose: () -> Void = {}
    @State private var message: String?
    @State private var showReviewer = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Sign in").font(.title2.bold()).foregroundStyle(Theme.text)
                Spacer()
                Button(action: onClose) { Image(systemName: "xmark").font(.title3) }
                    .foregroundStyle(Theme.text)
                    .accessibilityLabel("Close")
            }
            Text(reason).font(.body).foregroundStyle(Theme.text)
            SignInWithAppleButton(.continue, onRequest: { AppleSignIn.configure($0) }) { result in
                Task { await run { try await AppleSignIn.handle(result, auth: auth) } }
            }
            .signInWithAppleButtonStyle(scheme == .dark ? .white : .black)
            .id(scheme)
            .frame(height: 48)
            Button {
                Task { await run { try await GoogleSignIn.signIn(auth: auth) } }
            } label: {
                Text("Continue with Google").font(.headline).frame(maxWidth: .infinity, minHeight: 48)
            }
            .foregroundStyle(Theme.text)
            .background(RoundedRectangle(cornerRadius: 10).fill(Theme.surfaceRaised))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.border))
            if let message { Text(message).font(.footnote).foregroundStyle(Theme.destructive) }
            Button("Reviewer sign-in") { showReviewer = true }
                .font(.subheadline).underline().foregroundStyle(Theme.textSecondary)
            Text(footer).font(.subheadline).foregroundStyle(Theme.textSecondary)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.surface)
        .sheet(isPresented: $showReviewer) { ReviewerSignInSheet() }
    }

    private var footer: String {
        let base = "Guests can browse, play and read without an account."
        guard auth.isSignedIn, !auth.isLinkedAccount else { return base }
        return "You're browsing as \(auth.me?.displayName ?? auth.anonymousUsername). Signing in keeps that name, your ratings and comments. " + base
    }

    private func run(_ op: () async throws -> Void) async {
        do { try await op(); message = nil }
        catch APIError.notAvailable { message = "This sign-in option isn't available yet." }
        catch let e as APIError { message = e.userMessage }
        catch { message = "Sign-in was cancelled." }
    }
}

#if DEBUG
#Preview("Sign in · Light") {
    SignInView(reason: "Sign in to rate songs.").environmentObject(AuthStore.shared).preferredColorScheme(.light)
}

#Preview("Sign in · Dark") {
    SignInView(reason: "Sign in to rate songs.").environmentObject(AuthStore.shared).preferredColorScheme(.dark)
}
#endif
