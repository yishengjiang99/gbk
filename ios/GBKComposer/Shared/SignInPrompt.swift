import SwiftUI

private struct RequestSignInKey: EnvironmentKey {
    static let defaultValue: @MainActor (String) -> Void = { _ in }
}

extension EnvironmentValues {
    /// Ask for sign-in at the moment of a gated action (rate, comment, report, DM/Inbox, publish).
    /// The nearest `.signInPrompting()` presents the sheet, so it works from inside other sheets too.
    var requestSignIn: @MainActor (String) -> Void {
        get { self[RequestSignInKey.self] }
        set { self[RequestSignInKey.self] = newValue }
    }
}

private struct SignInPrompting: ViewModifier {
    @EnvironmentObject private var auth: AuthStore
    @State private var reason: String?

    func body(content: Content) -> some View {
        content
            .environment(\.requestSignIn) { reason = $0 }
            .sheet(isPresented: Binding(get: { reason != nil }, set: { if !$0 { reason = nil } })) {
                NavigationStack {
                    SignInView(reason: reason ?? "")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Theme.background.ignoresSafeArea())
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Not now") { reason = nil } } }
                }
                .presentationDetents([.medium, .large])
            }
            .onChange(of: auth.isSignedIn) { _, signedIn in if signedIn { reason = nil } }
    }
}

extension View {
    func signInPrompting() -> some View { modifier(SignInPrompting()) }
}

extension AuthStore {
    /// true when a session exists; otherwise asks for sign-in and returns false.
    func requireSession(_ reason: String, prompt: @MainActor (String) -> Void) -> Bool {
        if isSignedIn { return true }
        prompt(reason)
        return false
    }
}
