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

    var body: some View {
        List {
            if let u = model.user {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(u.displayName ?? u.handle).font(.title2.bold()).foregroundStyle(Theme.accent)
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
                    VStack(alignment: .leading) {
                        Text(s.title).font(.headline)
                        Text((s.labels + s.tags.map { "#\($0)" }).joined(separator: " ")).font(.caption).foregroundStyle(Theme.textSecondary)
                    }
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

/// Profile tab: `GET /api/me` then the public profile; sign-in gated.
struct ProfileView: View {
    @EnvironmentObject private var auth: AuthStore
    @State private var confirmDelete = false
    @State private var message: String?

    var body: some View {
        NavigationStack {
            Group {
                if let me = auth.me {
                    UserProfileView(handle: me.handle)
                        .toolbar {
                            Menu {
                                Button("Sign out") { Task { await auth.signOut() } }
                                Button("Delete account", role: .destructive) { confirmDelete = true }
                            } label: { Image(systemName: "gearshape") }
                        }
                } else if auth.isSignedIn {
                    ProgressView().task { await auth.loadMe() }
                } else {
                    SignInView(reason: "Sign in to see your profile and songs.")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Theme.background.ignoresSafeArea())
                        .navigationTitle("Profile")
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
