import AuthenticationServices
import SwiftUI

struct SignInView: View {
    @EnvironmentObject private var auth: AuthStore
    var reason: String
    @State private var message: String?
    @State private var showReviewer = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "music.note.house.fill").font(.system(size: 56)).foregroundStyle(Theme.accent)
            Text(reason).font(.headline).multilineTextAlignment(.center).foregroundStyle(Theme.text)
            SignInWithAppleButton(.signIn, onRequest: { AppleSignIn.configure($0) }) { result in
                Task { await run { try await AppleSignIn.handle(result, auth: auth) } }
            }
            .signInWithAppleButtonStyle(scheme == .dark ? .white : .black) // Apple HIG: white button on dark backgrounds
            .id(scheme)
            .frame(height: 48)
            Button {
                Task { await run { try await GoogleSignIn.signIn(auth: auth) } }
            } label: {
                Label("Sign in with Google", systemImage: "g.circle").frame(maxWidth: .infinity, minHeight: 48)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
            .foregroundStyle(Theme.onAccent)
            if let message { Text(message).font(.footnote).foregroundStyle(Theme.textSecondary) }
            Button("Sign in with a review account") { showReviewer = true }
                .font(.footnote)
                .foregroundStyle(Theme.accent)
        }
        .padding(32)
        .sheet(isPresented: $showReviewer) { ReviewerSignInSheet() }
    }

    private func run(_ op: () async throws -> Void) async {
        do { try await op(); message = nil }
        catch APIError.notAvailable { message = "Sign-in from the app is coming soon." }
        catch let e as APIError { message = e.userMessage }
        catch { message = "Sign-in was cancelled." }
    }
}

#if DEBUG
#Preview("Sign in · Light") {
    SignInView(reason: "Sign in to see your profile and songs.")
        .environmentObject(AuthStore.shared)
        .background(Theme.background)
        .preferredColorScheme(.light)
}

#Preview("Sign in · Dark") {
    SignInView(reason: "Sign in to see your profile and songs.")
        .environmentObject(AuthStore.shared)
        .background(Theme.background)
        .preferredColorScheme(.dark)
}
#endif
