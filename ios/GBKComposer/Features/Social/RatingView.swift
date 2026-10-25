import SwiftUI

/// 1–5 stars. Tap a star to rate, tap your current rating again to clear.
struct RatingView: View {
    let song: Song
    let onChange: (Song) -> Void
    @EnvironmentObject private var auth: AuthStore
    @Environment(\.requestSignIn) private var requestSignIn
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        HStack(spacing: 2) {
            ForEach(1...5, id: \.self) { star in
                Button {
                    auth.gate("Sign in to rate songs.", prompt: requestSignIn) { Task { await rate(star) } }
                } label: {
                    Image(systemName: star <= (song.myRating ?? 0) ? "star.fill" : "star")
                }
                .buttonStyle(.plain)
                .disabled(busy || song.isMine)
                .accessibilityLabel("\(star) stars")
            }
            Text(summary).font(.caption).foregroundStyle(Theme.textSecondary).padding(.leading, 4)
        }
        .foregroundStyle(Theme.accent)
        .help(error ?? "")
    }

    private var summary: String {
        guard let avg = song.ratingAvg, song.ratingCount > 0 else { return "—" }
        return String(format: "%.1f (%d)", avg, song.ratingCount)
    }

    private func rate(_ stars: Int) async {
        busy = true; defer { busy = false }
        let ep = song.myRating == stars ? Endpoints.clearRating(song.slug) : Endpoints.rate(song.slug, stars: stars)
        do {
            let r = try await APIClient.shared.send(ep, as: RatingSummary.self)
            ImpressionLogger.shared.markRate(stars: song.myRating == stars ? nil : stars, song: song.slug)
            var s = song; s.ratingAvg = r.ratingAvg; s.ratingCount = r.ratingCount; s.myRating = r.myRating
            onChange(s)
        } catch let e as APIError { error = e.userMessage } catch { self.error = "Couldn't rate." }
    }
}
