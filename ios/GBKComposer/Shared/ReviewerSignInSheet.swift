import SwiftUI

/// Small username/password sheet for App Review accounts.
struct ReviewerSignInSheet: View {
    @EnvironmentObject private var auth: AuthStore
    @Environment(\.dismiss) private var dismiss
    @State private var username = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Username", text: $username)
                        .textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Password", text: $password).textContentType(.password)
                } footer: { Text("For app-review accounts only.") }
                if let error { Section { Text(error).foregroundStyle(.red) } }
                Button {
                    Task { await submit() }
                } label: {
                    if busy { ProgressView() } else { Text("Sign in") }
                }
                .disabled(busy || username.isEmpty || password.isEmpty)
            }
            .navigationTitle("Review account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private func submit() async {
        busy = true; defer { busy = false }
        do {
            let token = try await ReviewerSignIn.signIn(username: username, password: password)
            auth.store(TokenPair(accessToken: token, tokenType: "Bearer", expiresIn: nil, refreshToken: nil, me: nil))
            password = ""
            await auth.loadMe()
            dismiss()
        } catch let f as ReviewerSignIn.Failure {
            switch f {
            case .wrongCredentials: error = "Wrong username or password."
            case .rateLimited: error = "Too many attempts. Wait 15 minutes."
            case .unavailable: error = "Review sign-in is turned off."
            case .expired, .noSession: error = "Sign-in didn't complete. Please try again."
            }
        } catch {
            self.error = "Couldn't reach the server."
        }
    }
}
