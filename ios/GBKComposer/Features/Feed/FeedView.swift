import SwiftUI

@MainActor
final class FeedViewModel: ObservableObject {
    @Published private(set) var items: [Song] = []
    @Published private(set) var error: String?
    @Published var query = FeedQuery() {
        didSet { if query != oldValue { Task { await reload() } } }
    }
    private var cursor: String?
    /// slug → model_version of the feed page that delivered it.
    private(set) var modelVersions: [String: String] = [:]
    private var exhausted = false
    private var loading = false
    let provider: FeedProviding

    init(provider: FeedProviding = APIClient.shared) { self.provider = provider }

    func reload() async {
        items = []; cursor = nil; exhausted = false; error = nil
        await loadMoreIfNeeded(current: nil)
    }

    func loadMoreIfNeeded(current: Song?) async {
        guard !loading, !exhausted else { return }
        if let current, let idx = items.firstIndex(where: { $0.slug == current.slug }), idx < items.count - 3 { return }
        loading = true
        defer { loading = false }
        let requested = query
        do {
            let page = try await provider.feedPage(requested, cursor: cursor, limit: 20)
            guard requested == query else { return }
            let known = Set(items.map(\.slug))
            items.append(contentsOf: page.items.filter { $0.midiURL != nil && !known.contains($0.slug) })
            for s in page.items { modelVersions[s.slug] = page.modelVersion ?? "unknown" }
            cursor = page.nextCursor
            exhausted = page.nextCursor == nil
            error = nil
        } catch {
            self.error = "Couldn't load the feed."
        }
    }

    /// Deep link: always pin `slug` as card 0 and drop its duplicate below (same as web 42adb71), fetching
    /// `GET /api/songs/:slug` only when it isn't loaded yet. Returns false when the song can't be found or has no audio.
    func focus(slug: String, fetch: (String) async throws -> Song = { try await APIClient.shared.send(Endpoints.song($0), as: Song.self) }) async -> Bool {
        if let i = items.firstIndex(where: { $0.slug == slug }) {
            let song = items.remove(at: i)
            items.insert(song, at: 0)
            return true
        }
        guard let song = try? await fetch(slug), song.midiURL != nil else { return false }
        items.removeAll { $0.slug == song.slug }
        items.insert(song, at: 0)
        return true
    }

    func update(_ song: Song) {
        if let i = items.firstIndex(where: { $0.slug == song.slug }) { items[i] = song }
    }
}

struct FeedView: View {
    @EnvironmentObject private var router: DeepLinkRouter
    @EnvironmentObject private var auth: AuthStore
    @Environment(\.requestSignIn) private var requestSignIn
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = FeedViewModel()
    @StateObject private var player = FeedPlayer()
    @State private var visibleSlug: String?
    @State private var commentsFor: Song?
    @State private var reportFor: Song?
    @State private var tagText = ""

    var body: some View {
        VStack(spacing: 0) {
            filterBar
            GeometryReader { geo in
                ScrollView(.vertical) {
                    LazyVStack(spacing: 0) {
                        ForEach(model.items) { song in
                            FeedCardView(song: song,
                                         playback: playback(for: song),
                                         onTap: { player.toggle() },
                                         onRated: { model.update($0) },
                                         onComments: { commentsFor = song },
                                         onReport: { auth.gate("Sign in to report.", prompt: requestSignIn) { reportFor = song } },
                                         onTag: { model.query.tag = $0; tagText = $0 },
                                         onOpen: { router.openInStudio(slug: song.slug, fork: false) },
                                         onFork: { router.openInStudio(slug: song.slug, fork: true) },
                                         onRemixPrompt: { slug, prompt in router.remixPrompt(slug: slug, prompt: prompt) })
                            .frame(width: geo.size.width, height: geo.size.height)
                            .id(song.slug)
                            .accessibilityElement(children: .contain)
                            .accessibilityIdentifier("feedCard-\(song.slug)")
                            .task { await model.loadMoreIfNeeded(current: song) }
                        }
                    }
                    .scrollTargetLayout()
                }
                .scrollTargetBehavior(.paging)
                .scrollPosition(id: $visibleSlug)
                .scrollIndicators(.hidden)
                .modifier(ScrollSpeedLogger())
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .overlay {
            if model.items.isEmpty {
                if let err = model.error { Text(err).foregroundStyle(Theme.accent) }
                else { ProgressView().tint(Theme.accent) }
            }
        }
        .sheet(item: $commentsFor) { song in
            CommentsSheet(song: song) { delta in
                var s = song; s.commentCount = max(0, s.commentCount + delta); model.update(s)
            }
        }
        .sheet(item: $reportFor) { song in
            ReportBlockSheet(kind: "song", target: song.slug, author: song.author.handle)
        }
        .task {
            player.onStart = { slug in Task { _ = try? await APIClient.shared.send(Endpoints.play(slug), as: [String: Int].self) } }
            if model.items.isEmpty { await model.reload() }
            if let link = router.pending { await open(link) } // cold start: the link arrived before this view
        }
        .onChange(of: visibleSlug) { _, slug in playVisible(slug) }
        // Section change (sort chip, label, #tag): the old section's song must not keep playing while the new one loads,
        // and the new section starts fresh from its first card.
        .onChange(of: model.query) { _, _ in player.stop(); ImpressionLogger.shared.end(); visibleSlug = nil }
        .onChange(of: model.items.map(\.slug)) { _, slugs in
            if let first = slugs.first, visibleSlug == nil || !slugs.contains(visibleSlug!) {
                visibleSlug = first; playVisible(first)
            }
        }
        .onChange(of: router.pending) { _, link in
            if let link { Task { await open(link) } }
        }
        .onChange(of: scenePhase) { _, phase in
            // Decided: the feed pauses when the app leaves the foreground (matches web pausing when the tab is hidden).
            if phase != .active { player.pause(); ImpressionLogger.shared.suspend() }
        }
        .onDisappear { player.pause(); ImpressionLogger.shared.end() }
    }

    private var filterBar: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(FeedSort.allCases) { sort in
                    Chip(title: sort.title, selected: model.query.sort == sort) { model.query.sort = sort }
                }
                Divider().frame(height: 20)
                Menu {
                    Button("Any label") { model.query.label = nil }
                    ForEach(SongLabel.all, id: \.self) { label in Button(label) { model.query.label = label } }
                } label: {
                    Chip(title: model.query.label ?? "Label", selected: model.query.label != nil, action: {})
                        .allowsHitTesting(false)
                }
                HStack(spacing: 4) {
                    Image(systemName: "number")
                    TextField("tag", text: $tagText)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .frame(width: 80)
                        .onSubmit { model.query.tag = tagText.trimmingCharacters(in: .whitespaces).lowercased().nilIfEmpty }
                    if model.query.tag != nil {
                        Button { tagText = ""; model.query.tag = nil } label: { Image(systemName: "xmark.circle.fill") }
                    }
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(Capsule().fill(Theme.chip))
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
        }
        .scrollIndicators(.hidden)
        .foregroundStyle(Theme.accent)
    }

    private func open(_ link: DeepLink) async {
        switch link {
        case .tag(let name): router.pending = nil; tagText = name; model.query.tag = name
        case .feed: router.pending = nil
        case .share(let slug):
            router.pending = nil
            guard await model.focus(slug: slug) else { return }
            visibleSlug = slug
            playVisible(slug)
        case .user, .inbox, .studioSong, .studio: break
        }
    }

    /// Only the visible, active card animates.
    private func playback(for song: Song) -> CardPlayback? {
        guard player.currentSlug == song.slug else { return nil }
        let slug = song.slug
        let p = player
        return CardPlayback(time: { [weak p] in p?.currentSeconds(for: slug) },
                            duration: { [weak p] in p?.durationSeconds(for: slug) },
                            analyzer: p.analyzer,
                            isPlaying: p.isPlaying)
    }

    private func playVisible(_ slug: String?) {
        guard let slug, let idx = model.items.firstIndex(where: { $0.slug == slug }),
              let url = model.items[idx].midiURL else { return }
        let p = player
        ImpressionLogger.shared.start(song: slug, position: idx, feed: model.query.sort.rawValue,
                                      modelVersion: model.modelVersions[slug] ?? "unknown",
                                      time: { p.currentSeconds(for: slug) }, duration: { p.durationSeconds(for: slug) })
        let next = idx + 1 < model.items.count ? model.items[idx + 1] : nil
        player.play(slug: slug, url: url, next: next.flatMap { n in n.midiURL.map { (slug: n.slug, url: $0) } })
    }
}

struct Chip: View {
    let title: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title).font(.subheadline.weight(.semibold))
                .padding(.horizontal, 14).padding(.vertical, 6)
                .foregroundStyle(selected ? Theme.onAccent : Theme.accent)
                .background(Capsule().fill(selected ? Theme.accent : Theme.chip))
        }
        .buttonStyle(.plain)
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

/// Feeds the scroll offset to ImpressionLogger.noteScroll for `scroll_v` (iOS 18+; older systems send none).
private struct ScrollSpeedLogger: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollGeometryChange(for: Double.self, of: { Double($0.contentOffset.y) }) { _, y in
                ImpressionLogger.shared.noteScroll(offset: y)
            }
        } else { content }
    }
}
