import SwiftUI

/// What a gated action needs. Guests (two-word device accounts) can rate, comment and report;
/// publish, DM and the Profile/Inbox tabs need Apple/Google (docs/social/feed-design.md, docs/social-api.md).
enum SignInNeed { case session, linkedAccount }

/// Opens the sign-in sheet for a gated action and replays `resume` once sign-in completes
/// (iOS keeps the pending action in memory, feed-design.md "Resume the exact action after sign-in").
struct SignInRequester {
    var present: @MainActor (_ reason: String, _ need: SignInNeed, _ resume: (@MainActor () -> Void)?) -> Void = { _, _, _ in }

    @MainActor func callAsFunction(_ reason: String, need: SignInNeed = .linkedAccount, then resume: (@MainActor () -> Void)? = nil) {
        present(reason, need, resume)
    }
}

private struct RequestSignInKey: EnvironmentKey {
    static let defaultValue = SignInRequester()
}

extension EnvironmentValues {
    /// The nearest `.signInPrompting()` presents the sheet, so it works from inside other sheets too.
    var requestSignIn: SignInRequester {
        get { self[RequestSignInKey.self] }
        set { self[RequestSignInKey.self] = newValue }
    }
}

/// Pending gated action, replayed when the store satisfies its need.
struct PendingSignIn {
    let reason: String
    let need: SignInNeed
    let resume: (@MainActor () -> Void)?

    @MainActor func isSatisfied(by auth: AuthStore) -> Bool {
        need == .session ? auth.isSignedIn : auth.isLinkedAccount
    }
}

private struct SignInPrompting: ViewModifier {
    @EnvironmentObject private var auth: AuthStore
    @State private var pending: PendingSignIn?

    func body(content: Content) -> some View {
        content
            .environment(\.requestSignIn, SignInRequester { reason, need, resume in
                pending = PendingSignIn(reason: reason, need: need, resume: resume)
            })
            .sheet(isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } })) {
                SignInView(reason: pending?.reason ?? "", onClose: { pending = nil })
                    .presentationDetents([.medium, .large])
                    .presentationBackground(Theme.surface)
            }
            .onChange(of: auth.isLinkedAccount) { _, _ in replayIfSatisfied() }
            .onChange(of: auth.isSignedIn) { _, _ in replayIfSatisfied() }
    }

    private func replayIfSatisfied() {
        guard let p = pending, p.isSatisfied(by: auth) else { return }
        pending = nil
        p.resume?()
    }
}

extension View {
    func signInPrompting() -> some View { modifier(SignInPrompting()) }
}

extension AuthStore {
    /// Runs `action` now when the need is met; otherwise opens the sign-in sheet and runs it after sign-in.
    func gate(_ reason: String, need: SignInNeed = .session, prompt: SignInRequester, _ action: @escaping @MainActor () -> Void) {
        let ok = need == .session ? isSignedIn : isLinkedAccount
        if ok { action() } else { prompt(reason, need: need, then: action) }
    }
}
