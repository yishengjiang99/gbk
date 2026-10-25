import SwiftUI

@MainActor
final class FeedViewModel: ObservableObject {
    @Published private(set) var items: [Share] = []
    @Published private(set) var error: String?
    private var cursor: String?
    private var exhausted = false
    private var loading = false
    let provider: FeedProviding

    init(provider: FeedProviding = APIClient.shared) { self.provider = provider }

    func loadMoreIfNeeded(current: Share?) async {
        guard !loading, !exhausted else { return }
        if let current, let idx = items.firstIndex(of: current), idx < items.count - 3 { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await provider.feedPage(cursor: cursor, limit: 20)
            let known = Set(items.map(\.slug))
            items.append(contentsOf: page.shares.filter { $0.hasMp3 && !known.contains($0.slug) })
            cursor = page.nextCursor
            exhausted = page.nextCursor == nil
            error = nil
        } catch {
            self.error = "Couldn't load the feed."
        }
    }
}

struct FeedView: View {
    @StateObject private var model = FeedViewModel()
    @StateObject private var player = FeedPlayer()
    @State private var visibleSlug: String?

    var body: some View {
        GeometryReader { geo in
            ScrollView(.vertical) {
                LazyVStack(spacing: 0) {
                    ForEach(model.items) { share in
                        FeedCardView(share: share, isPlaying: player.isPlaying && player.currentSlug == share.slug) {
                            player.toggle()
                        }
                        .frame(width: geo.size.width, height: geo.size.height)
                        .id(share.slug)
                        .task { await model.loadMoreIfNeeded(current: share) }
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.paging)
            .scrollPosition(id: $visibleSlug)
            .scrollIndicators(.hidden)
        }
        .background(Theme.background.ignoresSafeArea())
        .overlay {
            if model.items.isEmpty {
                if let err = model.error {
                    Text(err).foregroundStyle(Theme.accent)
                } else {
                    ProgressView().tint(Theme.accent)
                }
            }
        }
        .task { await model.loadMoreIfNeeded(current: nil) }
        .onChange(of: visibleSlug) { _, slug in playVisible(slug) }
        .onChange(of: model.items) { _, items in
            if visibleSlug == nil, let first = items.first { visibleSlug = first.slug; playVisible(first.slug) }
        }
        .onDisappear { player.pause() }
    }

    private func playVisible(_ slug: String?) {
        guard let slug, let idx = model.items.firstIndex(where: { $0.slug == slug }) else { return }
        let client = APIClient.shared
        let next = idx + 1 < model.items.count ? model.items[idx + 1] : nil
        player.play(slug: slug, url: client.mediaURL(slug: slug, kind: "mp3"),
                    next: next.map { (slug: $0.slug, url: client.mediaURL(slug: $0.slug, kind: "mp3")) })
    }
}
