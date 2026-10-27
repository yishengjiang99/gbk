import SwiftUI

@MainActor
final class ProfileModel: ObservableObject {
    @Published var user: User?
    @Published var songs: [Song] = []
    @Published var error: String?
    private var cursor: String?
    @Published private(set) var done = false

    func load(handle: String, reset: Bool = true) async {
        if reset { songs = []; cursor = nil; done = false }
        guard !done else { return }
        do {
            let page = try await APIClient.shared.send(Endpoints.user(handle, cursor: cursor), as: UserProfilePage.self)
            user = page.user; songs += page.songs; cursor = page.nextCursor; done = page.nextCursor == nil
        } catch APIError.notAvailable { error = "No such user."; done = true }
        catch { self.error = "Couldn't load the profile."; done = true }
    }
}

/// Public profile: `GET /api/users/:handle`.
struct UserProfileView: View {
    let handle: String
    @StateObject private var model = ProfileModel()
    @State private var reportUser = false
    @EnvironmentObject private var auth: AuthStore
    @EnvironmentObject private var router: DeepLinkRouter

    var body: some View {
        List {
            if let u = model.user {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            Text(u.displayName ?? u.handle).font(.title2.bold()).foregroundStyle(Theme.accent)
                            if u.pro == true { ProBadge() }
                        }
                        Text("@\(u.handle)").foregroundStyle(Theme.textSecondary)
                        HStack(spacing: 12) {
                            Label("\(u.songCount ?? 0) songs", systemImage: "music.note")
                            if let r = u.ratingAvg { Label(String(format: "%.1f", r), systemImage: "star.fill") }
                        }.font(.caption)
                    }
                }
            }
            Section("Songs") {
                ForEach(model.songs) { s in
                    // Same path as the /s/<slug> deep link: Feed tab, this song first, playing.
                    Button { router.open(.share(slug: s.slug)) } label: {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(s.title).font(.headline).foregroundStyle(Theme.text)
                                Text((s.labels + s.tags.map { "#\($0)" }).joined(separator: " ")).font(.caption).foregroundStyle(Theme.textSecondary)
                            }
                            Spacer()
                            Image(systemName: "play.circle.fill").foregroundStyle(Theme.accent)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("profileSong-\(s.slug)")
                }
                if !model.done { ProgressView().task { await model.load(handle: handle, reset: false) } }
            }
            if let e = model.error { Text(e).foregroundStyle(Theme.textSecondary) }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("@\(handle)")
        .toolbar {
            if auth.isSignedIn, auth.me?.handle != handle {
                Button { reportUser = true } label: { Image(systemName: "flag") }
            }
        }
        .sheet(isPresented: $reportUser) { ReportBlockSheet(kind: "user", target: handle, author: handle) }
        .task { if model.user == nil { await model.load(handle: handle) } }
    }
}

/// Profile tab. Works signed out: shows the install's two-word username. Apple/Google sign-in links it later.
struct ProfileView: View {
    @EnvironmentObject private var auth: AuthStore
    @Environment(\.requestSignIn) private var requestSignIn
    @State private var confirmDelete = false
    @State private var message: String?

    var body: some View {
        NavigationStack {
            Group {
                // Linked account or guest: own profile (guest shows its two-word name), with the gear menu.
                if auth.isSignedIn, let me = auth.me {
                    UserProfileView(handle: me.handle)
                        .toolbar {
                            Menu {
                                Button("Bluetooth MIDI…") { BluetoothMIDIPairing.present() }
                                if auth.isLinkedAccount { Button("Sign out") { Task { await auth.signOut() } } }
                                Button("Delete account", role: .destructive) { confirmDelete = true }
                                AboutMenuItems()
                            } label: { Image(systemName: "gearshape") }
                        }
                } else if auth.isSignedIn {
                    ProgressView().task { await auth.loadMe() }
                } else {
                    // No session yet (guest sign-up pending/offline): the local two-word name. No sign-in button.
                    AnonymousProfileView(username: auth.me?.displayName ?? auth.anonymousUsername,
                                         hasAnonymousSession: auth.isSignedIn)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Theme.background.ignoresSafeArea())
                    .navigationTitle("Profile")
                    .toolbar { Menu { AboutMenuItems() } label: { Image(systemName: "info.circle") }.accessibilityLabel("About") }
                }
            }
            .toolbar { ToolbarItem(placement: .topBarLeading) { ProButton() } }
            .alert("Delete your account?", isPresented: $confirmDelete) {
                Button("Delete", role: .destructive) { Task { await deleteAccount() } }
                Button("Cancel", role: .cancel) {}
            } message: { Text("This removes your songs, comments, ratings and messages.") }
            .alert(message ?? "", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {}
        }
    }

    private func deleteAccount() async {
        do { try await auth.deleteAccount() }
        catch let e as APIError { message = e == .notAvailable ? "Account deletion isn't available yet." : e.userMessage }
        catch { message = "Couldn't delete the account." }
    }
}

/// Signed-out / anonymous profile: the random two-word username plus a sign-in button.
struct AnonymousProfileView: View {
    let username: String
    let hasAnonymousSession: Bool

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "person.crop.circle.fill").font(.system(size: 72)).foregroundStyle(Theme.accent)
            Text(username).font(.title.bold()).foregroundStyle(Theme.text)
                .accessibilityIdentifier("anonymous-username")
            Text(hasAnonymousSession ? "This is your name on GBK."
                                     : "Your name on GBK. Listen, explore and create without an account.")
                .font(.subheadline).multilineTextAlignment(.center).foregroundStyle(Theme.textSecondary)
        }
        .padding(32)
    }
}

/// About: the iOS app is AGPL-3.0-or-later open source (ios/LICENSE); link to its corresponding source.
struct AboutMenuItems: View {
    static let sourceURL = URL(string: "https://github.com/yishengjiang99/gbk/tree/main/ios")!
    static let noticesURL = URL(string: "https://github.com/yishengjiang99/gbk/blob/main/ios/THIRD_PARTY_NOTICES.md")!
    var body: some View {
        Section("About") {
            Link(destination: Self.sourceURL) { Label("Source code (AGPL-3.0)", systemImage: "chevron.left.forwardslash.chevron.right") }
            Link(destination: Self.noticesURL) { Label("Third-party notices", systemImage: "doc.text") }
        }
    }
}
