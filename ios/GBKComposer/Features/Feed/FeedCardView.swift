import SwiftUI

struct FeedCardView: View {
    let song: Song
    let isPlaying: Bool
    let onTap: () -> Void
    let onRated: (Song) -> Void
    let onComments: () -> Void
    let onReport: () -> Void
    let onTag: (String) -> Void

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(Theme.cardGradient)
                .overlay {
                    Image(systemName: isPlaying ? "waveform" : "play.circle.fill")
                        .font(.system(size: 72, weight: .light))
                        .foregroundStyle(Theme.accent.opacity(0.8))
                        .symbolEffect(.variableColor.iterative, isActive: isPlaying)
                }
                .shadow(color: Theme.accent.opacity(0.15), radius: 12, y: 6)
                .onTapGesture(count: 2) { Task { await quickLove() } }
                .onTapGesture(perform: onTap)
            VStack(alignment: .leading, spacing: 8) {
                Text(song.title).font(.title2.bold()).foregroundStyle(Theme.accent)
                NavigationLink(value: song.author.handle) {
                    Text("@\(song.author.handle)").font(.subheadline)
                }
                .foregroundStyle(.secondary)
                if !(song.labels.isEmpty && song.tags.isEmpty) {
                    HStack(spacing: 6) {
                        ForEach(song.labels, id: \.self) { Text($0).font(.caption.bold()).padding(4)
                            .background(Capsule().fill(Theme.accent.opacity(0.15))) }
                        ForEach(song.tags, id: \.self) { tag in
                            Button("#\(tag)") { onTag(tag) }.font(.caption)
                        }
                    }
                }
                HStack(spacing: 16) {
                    RatingView(song: song, onChange: onRated)
                    Button(action: onComments) { Label("\(song.commentCount)", systemImage: "bubble.left") }
                    Label("\(song.playCount)", systemImage: "play").foregroundStyle(.secondary)
                    Spacer()
                    if !song.isMine {
                        Button(action: onReport) { Image(systemName: "flag") }.accessibilityLabel("Report")
                    }
                }
                .font(.subheadline)
                .foregroundStyle(Theme.accent)
            }
            .padding(24)
        }
        .padding(16)
    }

    /// Double-tap = 5 stars (doc: "like" maps to rating).
    private func quickLove() async {
        guard !song.isMine, AuthStore.currentAccessToken() != nil,
              let r = try? await APIClient.shared.send(Endpoints.rate(song.slug, stars: 5), as: RatingSummary.self) else { return }
        var s = song; s.ratingAvg = r.ratingAvg; s.ratingCount = r.ratingCount; s.myRating = r.myRating
        onRated(s)
    }
}
