import SwiftUI

/// Flat comments for a song: list, post, delete own (`can_delete`).
struct CommentsSheet: View {
    let song: Song
    /// +1 on post, -1 on delete.
    let onCountChange: (Int) -> Void
    @EnvironmentObject private var auth: AuthStore
    @Environment(\.requestSignIn) private var requestSignIn
    @Environment(\.dismiss) private var dismiss
    @State private var items: [Comment] = []
    @State private var cursor: String?
    @State private var done = false
    @State private var draft = ""
    @State private var error: String?
    @State private var reportTarget: Comment?

    var body: some View {
        NavigationStack {
            List {
                ForEach(items) { c in
                    VStack(alignment: .leading, spacing: 4) {
                        Text("@\(c.author.handle)").font(.caption.bold()).foregroundStyle(Theme.accent)
                        Text(verbatim: c.body)
                    }
                    .swipeActions {
                        if c.canDelete {
                            Button("Delete", role: .destructive) { Task { await delete(c) } }
                        } else if auth.isSignedIn {
                            Button("Report") { reportTarget = c }.tint(.orange)
                        }
                    }
                }
                if !done {
                    ProgressView().frame(maxWidth: .infinity).task { await loadMore() }
                } else if items.isEmpty {
                    Text("No comments yet.").foregroundStyle(Theme.textSecondary)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("Comments")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .safeAreaInset(edge: .bottom) { composer }
            .sheet(item: $reportTarget) { c in ReportBlockSheet(kind: "comment", target: c.id, author: c.author.handle) }
        }
        .signInPrompting()
    }

    @ViewBuilder private var composer: some View {
        VStack(spacing: 4) {
            if let error { Text(error).font(.footnote).foregroundStyle(Theme.destructive) }
            // Anyone can type; Post is the gated action (guest session suffices), replayed after sign-in.
            HStack {
                TextField("Add a comment", text: $draft, axis: .vertical).lineLimit(1...4)
                Button("Post") { auth.gate("Sign in to comment.", prompt: requestSignIn) { Task { await post() } } }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || draft.count > 500)
            }
        }
        .padding().background(.ultraThinMaterial)
    }

    private func loadMore() async {
        do {
            let page = try await APIClient.shared.send(Endpoints.comments(song.slug, cursor: cursor), as: Page<Comment>.self)
            items += page.items; cursor = page.nextCursor; done = page.nextCursor == nil
        } catch { done = true; self.error = "Couldn't load comments." }
    }

    private func post() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let c = try await APIClient.shared.send(Endpoints.postComment(song.slug, body: text), as: Comment.self)
            ImpressionLogger.shared.mark(.comment, song: song.slug)
            items.insert(c, at: 0); draft = ""; error = nil; onCountChange(1)
        } catch APIError.rateLimited(_, let body) where auth.isSignedIn && !auth.isLinkedAccount {
            // Guests: 20 comments/day. Offer sign-in to lift it, then post the kept draft.
            error = body?.message ?? "Guests can post 20 comments a day; sign in to lift the limit."
            requestSignIn("Guests can post 20 comments a day. Sign in to keep commenting.") { Task { await post() } }
        } catch let e as APIError { error = e.userMessage } catch { self.error = "Couldn't post." }
    }

    private func delete(_ c: Comment) async {
        do {
            _ = try await APIClient.shared.send(Endpoints.deleteComment(c.id), as: OKResult.self)
            items.removeAll { $0.id == c.id }; onCountChange(-1)
        } catch let e as APIError { error = e.userMessage } catch { self.error = "Couldn't delete." }
    }
}
