import SwiftUI

/// Feed card. Row 1: windowed piano roll. Row 2: spectrum bars | waveform. Only the active card gets a `playback`.
struct FeedCardView: View {
    let song: Song
    let playback: CardPlayback?
    var onTap: () -> Void = {}
    var onRated: (Song) -> Void = { _ in }
    var onComments: () -> Void = {}
    var onReport: () -> Void = {}
    var onTag: (String) -> Void = { _ in }

    private var isPlaying: Bool { playback?.isPlaying ?? false }
    @EnvironmentObject private var auth: AuthStore
    @Environment(\.requestSignIn) private var requestSignIn

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(song.title).font(.title2.bold()).foregroundStyle(Theme.text).lineLimit(2)
                NavigationLink(value: song.author.handle) {
                    Text("@\(song.author.handle)").font(.subheadline)
                }
                .foregroundStyle(Theme.textSecondary)
            }

            LiveRollView(preview: song.preview, tracks: song.preview?.tracks ?? [], playback: playback)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Theme.surfaceRaised))
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay {
                    if !isPlaying {
                        Image(systemName: "play.circle.fill")
                            .font(.system(size: 56, weight: .light))
                            .foregroundStyle(Theme.accent.opacity(0.85))
                    }
                }
                .contentShape(Rectangle())
                .onTapGesture(count: 2) {
                    guard !song.isMine, auth.requireSession("Sign in to rate songs.", prompt: requestSignIn) else { return }
                    Task { await quickLove() }
                }
                .onTapGesture(perform: onTap)

            HStack(spacing: 10) {
                SpectrumBarsView(playback: playback)
                WaveformView(playback: playback)
            }
            .frame(height: 56)
            .padding(8)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.surfaceRaised))

            if !(song.labels.isEmpty && song.tags.isEmpty) {
                HStack(spacing: 6) {
                    ForEach(song.labels, id: \.self) {
                        Text($0).font(.caption.bold()).foregroundStyle(Theme.accent)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Capsule().fill(Theme.accent.opacity(0.15)))
                    }
                    ForEach(song.tags, id: \.self) { tag in
                        Button("#\(tag)") { onTag(tag) }.font(.caption).foregroundStyle(Theme.accent)
                    }
                }
            }

            HStack(spacing: 16) {
                RatingView(song: song, onChange: onRated)
                Button(action: onComments) { Label("\(song.commentCount)", systemImage: "bubble.left") }
                Label("\(song.playCount)", systemImage: "play").foregroundStyle(Theme.textSecondary)
                Spacer()
                if !song.isMine {
                    Button(action: onReport) { Image(systemName: "flag") }.accessibilityLabel("Report")
                }
            }
            .font(.subheadline)
            .foregroundStyle(Theme.accent)
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

    /// Double-tap = 5 stars (doc: "like" maps to rating).
    private func quickLove() async {
        guard let r = try? await APIClient.shared.send(Endpoints.rate(song.slug, stars: 5), as: RatingSummary.self) else { return }
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
