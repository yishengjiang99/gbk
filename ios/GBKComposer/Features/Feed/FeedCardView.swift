import SwiftUI

/// Feed card, laid out like the web card (src/components/social/SocialApp.tsx): the viz fills the top
/// with the action rail down its right side and the play button over its bottom-left corner; title,
/// author line, rating, tags and the prompt box sit below it. The viz itself stays the iOS
/// piano roll + spectrum/waveform (`NowPlayingVizView`).
struct FeedCardView: View {
    let song: Song
    let playback: CardPlayback?
    var onTap: () -> Void = {}
    var onRated: (Song) -> Void = { _ in }
    var onComments: () -> Void = {}
    var onReport: () -> Void = {}
    var onTag: (String) -> Void = { _ in }
    /// Open this song in the Studio (web card's "open").
    var onOpen: () -> Void = {}
    /// Fork this song into the Studio (web card's fork button).
    var onFork: () -> Void = {}
    /// "Remix this prompt": hand the shared prompt to the Studio composer.
    var onRemixPrompt: (String) -> Void = { _ in }

    private var isPlaying: Bool { playback?.isPlaying ?? false }
    @EnvironmentObject private var auth: AuthStore
    @Environment(\.requestSignIn) private var requestSignIn

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            vizBlock
            metaBlock
        }
        .padding(20)
        .background(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(Theme.cardGradient)
                .shadow(color: Theme.accent.opacity(0.15), radius: 12, y: 6)
        )
        .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).stroke(Theme.border, lineWidth: 1))
        .padding(16)
    }

    // MARK: Viz with the web card's overlays

    private var vizBlock: some View {
        NowPlayingVizView(preview: song.preview, playback: playback)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Theme.vizBg))
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(alignment: .top) {
                if !isPlaying {
                    // Web: the "Tap to play" pill floats over the roll until audio is running.
                    Label("Tap to play", systemImage: "speaker.wave.2.fill")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 16).padding(.vertical, 9)
                        .background(Capsule().fill(Theme.surfaceRaised).shadow(color: .black.opacity(0.18), radius: 6, y: 2))
                        .foregroundStyle(Theme.text)
                        .padding(.top, 12)
                        .allowsHitTesting(false)
                }
            }
            .overlay(alignment: .trailing) {
                VStack(spacing: 10) {
                    railButton(icon: "bubble.left.fill", label: "\(song.commentCount)", action: onComments)
                        .accessibilityLabel("Comments")
                    railButton(icon: "pencil", label: "open", action: onOpen)
                        .accessibilityLabel("Open in Studio")
                    ShareLink(item: song.shareURL, subject: Text(song.title), message: Text(song.title)) {
                        railLabel(icon: "arrow.up.right", label: "share")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Share")
                    .accessibilityIdentifier("feed-share")
                    railButton(icon: "arrow.triangle.branch", label: "\(song.forkCount)", action: onFork)
                        .accessibilityLabel("Remix (fork)")
                    if !song.isMine {
                        railButton(icon: "flag", label: nil, action: onReport)
                            .accessibilityLabel("Report")
                    }
                }
                .padding(.trailing, 10)
            }
            .overlay(alignment: .bottomLeading) {
                Button(action: onTap) {
                    Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 22, weight: .bold))
                        .foregroundStyle(Theme.onAccent)
                        .frame(width: 56, height: 56)
                        .background(Circle().fill(Theme.accent).shadow(color: .black.opacity(0.25), radius: 8, y: 3))
                }
                .buttonStyle(.plain)
                .padding(12)
                .accessibilityLabel(isPlaying ? "Pause" : "Play")
            }
            .contentShape(Rectangle())
            .onTapGesture(count: 2) {
                guard !song.isMine else { return }
                auth.gate("Sign in to rate songs.", prompt: requestSignIn) { Task { await quickLove() } }
            }
            .onTapGesture(perform: onTap)
    }

    /// One circular button in the right-side rail: glyph over a small caption, like the web card.
    private func railButton(icon: String, label: String?, action: @escaping () -> Void) -> some View {
        Button(action: action) { railLabel(icon: icon, label: label) }.buttonStyle(.plain)
    }

    private func railLabel(icon: String, label: String?) -> some View {
        VStack(spacing: 1) {
            Image(systemName: icon).font(.system(size: 16, weight: .semibold))
            if let label { Text(label).font(.caption2.weight(.medium)).lineLimit(1) }
        }
        .foregroundStyle(Theme.text)
        .frame(width: 52, height: 52)
        .background(Circle().fill(Theme.surfaceRaised.opacity(0.92)))
        .overlay(Circle().stroke(Theme.border, lineWidth: 1))
        .shadow(color: .black.opacity(0.12), radius: 4, y: 2)
    }

    // MARK: Meta below the viz (web order: title, author line, stars, chips, prompt)

    private var metaBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(song.title).font(.title2.bold()).foregroundStyle(Theme.text).lineLimit(2)
            HStack(spacing: 6) {
                NavigationLink(value: song.author.handle) {
                    Text("@\(song.author.handle)").font(.subheadline)
                }
                .simultaneousGesture(TapGesture().onEnded { ImpressionLogger.shared.mark(.profileTap, song: song.slug) })
                if let badge = song.author.badge, !badge.isEmpty {
                    Text(badge)
                        .font(.caption2.weight(.bold))
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Capsule().fill(Color(red: 0.05, green: 0.35, blue: 0.25)))
                        .foregroundStyle(Color(red: 0.45, green: 0.95, blue: 0.75))
                }
                if song.author.pro == true { ProBadge() }
                Text("· \(song.playCount) plays").font(.subheadline)
                if let publishedAt = song.publishedAt, publishedAt > 0 {
                    Text("· \(Self.ago(publishedAt))").font(.subheadline)
                }
            }
            .foregroundStyle(Theme.textSecondary)

            RatingView(song: song, onChange: onRated)

            if !(song.labels.isEmpty && song.tags.isEmpty) {
                TagChips(labels: song.labels, tags: song.tags, onTag: onTag)
            }

            if song.promptShared == true, let prompt = song.promptText, !prompt.isEmpty {
                HStack(alignment: .center, spacing: 12) {
                    Text("\u{201C}\(prompt)\u{201D}")
                        .font(.subheadline).foregroundStyle(Theme.text)
                        .lineLimit(2)
                    Spacer(minLength: 0)
                    Button("Remix this prompt") { onRemixPrompt(prompt) }
                        .font(.subheadline.weight(.semibold))
                        .buttonStyle(.bordered)
                        .tint(Theme.accent)
                }
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color(red: 0.05, green: 0.35, blue: 0.25).opacity(0.14)))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color(red: 0.05, green: 0.35, blue: 0.25).opacity(0.45), lineWidth: 1))
            }
        }
    }

    /// Web `ago`: published_at is epoch milliseconds.
    static func ago(_ millis: Int64) -> String {
        let s = max(0, (Date().timeIntervalSince1970 - Double(millis) / 1000))
        if s < 60 { return "now" }
        if s < 3600 { return "\(Int(s / 60))m" }
        if s < 86400 { return "\(Int(s / 3600))h" }
        return "\(Int(s / 86400))d"
    }

    /// Double-tap = 5 stars (doc: "like" maps to rating).
    private func quickLove() async {
        guard let r = try? await APIClient.shared.send(Endpoints.rate(song.slug, stars: 5), as: RatingSummary.self) else { return }
        ImpressionLogger.shared.markRate(stars: 5, song: song.slug)
        var s = song; s.ratingAvg = r.ratingAvg; s.ratingCount = r.ratingCount; s.myRating = r.myRating
        onRated(s)
    }
}

#if DEBUG
enum PreviewFixtures {
    static let song: Song = {
        let json = """
        {"slug":"preview-song","title":"The Clockwork Cathedral","url":null,
         "author":{"handle":"yisheng","display_name":"yisheng","avatar_url":null,"song_count":11,"rating_avg":4.2,"created_at":0},
         "created_at":0,"published_at":0,"labels":["classical"],"tags":["piano","fugue"],"rating_avg":4.2,"rating_count":5,
         "comment_count":3,"play_count":120,"fork_count":1,"my_rating":null,"media":null,
         "preview":{"tracks":["#4fc3f7","#ffb74d","#81c784","#e57373"],"lo":38,"hi":86,"end":61440,
           "notes":[[0,0,40,62],[1,20,30,74],[2,60,40,50],[3,90,20,81],[0,120,40,65],[1,170,30,77],[2,200,60,46],[3,260,20,84],[0,300,50,69],[1,360,40,72],[2,420,50,55],[3,480,30,79],[0,540,40,60],[1,600,30,70],[2,650,60,48],[3,720,30,86],[0,780,40,64],[1,840,40,75],[2,900,60,43],[3,960,30,82]]},
         "prompt_shared":false,"prompt_text":null,"parent_slug":null,"is_mine":false}
        """
        return try! APIClient.makeDecoder().decode(Song.self, from: Data(json.utf8))
    }()
}

#Preview("Card · Light") {
    FeedCardView(song: PreviewFixtures.song, playback: nil)
        .environmentObject(AuthStore.shared)
        .background(Theme.background)
        .preferredColorScheme(.light)
}

#Preview("Card · Dark") {
    FeedCardView(song: PreviewFixtures.song, playback: nil)
        .environmentObject(AuthStore.shared)
        .background(Theme.background)
        .preferredColorScheme(.dark)
}
#endif
