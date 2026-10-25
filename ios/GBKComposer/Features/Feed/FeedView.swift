import SwiftUI

@MainActor
final class FeedViewModel: ObservableObject {
    @Published private(set) var items: [Song] = []
    @Published private(set) var error: String?
    @Published var query = FeedQuery() {
        didSet { if query != oldValue { Task { await reload() } } }
    }
    private var cursor: String?
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
            items.append(contentsOf: page.items.filter { $0.mp3URL != nil && !known.contains($0.slug) })
            cursor = page.nextCursor
            exhausted = page.nextCursor == nil
            error = nil
        } catch {
            self.error = "Couldn't load the feed."
        }
    }

    func update(_ song: Song) {
        if let i = items.firstIndex(where: { $0.slug == song.slug }) { items[i] = song }
    }
}

struct FeedView: View {
    @EnvironmentObject private var router: DeepLinkRouter
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
                                         isPlaying: player.isPlaying && player.currentSlug == song.slug,
                                         onTap: { player.toggle() },
                                         onRated: { model.update($0) },
                                         onComments: { commentsFor = song },
                                         onReport: { reportFor = song },
                                         onTag: { model.query.tag = $0; tagText = $0 })
                            .frame(width: geo.size.width, height: geo.size.height)
                            .id(song.slug)
                            .task { await model.loadMoreIfNeeded(current: song) }
                        }
                    }
                    .scrollTargetLayout()
                }
                .scrollTargetBehavior(.paging)
                .scrollPosition(id: $visibleSlug)
                .scrollIndicators(.hidden)
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
        }
        .onChange(of: visibleSlug) { _, slug in playVisible(slug) }
        .onChange(of: model.items.map(\.slug)) { _, slugs in
            if let first = slugs.first, visibleSlug == nil || !slugs.contains(visibleSlug!) {
                visibleSlug = first; playVisible(first)
            }
        }
        .onChange(of: router.pending) { _, link in
            if case .tag(let name)? = link { tagText = name; model.query.tag = name; router.pending = nil }
        }
        .onDisappear { player.pause() }
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
                .background(Capsule().fill(Color.white.opacity(0.7)))
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
        }
        .scrollIndicators(.hidden)
        .foregroundStyle(Theme.accent)
    }

    private func playVisible(_ slug: String?) {
        guard let slug, let idx = model.items.firstIndex(where: { $0.slug == slug }),
              let url = model.items[idx].mp3URL else { return }
        let next = idx + 1 < model.items.count ? model.items[idx + 1] : nil
        player.play(slug: slug, url: url, next: next.flatMap { n in n.mp3URL.map { (slug: n.slug, url: $0) } })
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
                .foregroundStyle(selected ? Color.white : Theme.accent)
                .background(Capsule().fill(selected ? Theme.accent : Color.white.opacity(0.7)))
        }
        .buttonStyle(.plain)
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
