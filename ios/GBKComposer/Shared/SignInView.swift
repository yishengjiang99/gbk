import AuthenticationServices
import SwiftUI

struct SignInView: View {
    @EnvironmentObject private var auth: AuthStore
    var reason: String
    @State private var message: String?

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "music.note.house.fill").font(.system(size: 56)).foregroundStyle(Theme.accent)
            Text(reason).font(.headline).multilineTextAlignment(.center)
            SignInWithAppleButton(.signIn, onRequest: AppleSignIn.configure) { result in
                AppleSignIn.handle(result, auth: auth)
            }
            .signInWithAppleButtonStyle(.black)
            .frame(height: 48)
            Button {
                Task {
                    do { try await GoogleSignIn.signIn(auth: auth) } catch { message = "Google sign-in is coming soon." }
                }
            } label: {
                Label("Sign in with Google", systemImage: "g.circle").frame(maxWidth: .infinity, minHeight: 48)
            }
            .buttonStyle(.borderedProminent)
            if let message { Text(message).font(.footnote).foregroundStyle(.secondary) }
        }
        .padding(32)
    }
}
