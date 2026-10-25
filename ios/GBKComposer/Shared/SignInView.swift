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
            SignInWithAppleButton(.signIn, onRequest: { AppleSignIn.configure($0) }) { result in
                Task { await run { try await AppleSignIn.handle(result, auth: auth) } }
            }
            .signInWithAppleButtonStyle(.black)
            .frame(height: 48)
            Button {
                Task { await run { try await GoogleSignIn.signIn(auth: auth) } }
            } label: {
                Label("Sign in with Google", systemImage: "g.circle").frame(maxWidth: .infinity, minHeight: 48)
            }
            .buttonStyle(.borderedProminent)
            if let message { Text(message).font(.footnote).foregroundStyle(.secondary) }
        }
        .padding(32)
    }

    private func run(_ op: () async throws -> Void) async {
        do { try await op(); message = nil }
        catch APIError.notAvailable { message = "Sign-in from the app is coming soon." }
        catch let e as APIError { message = e.userMessage }
        catch { message = "Sign-in was cancelled." }
    }
}
