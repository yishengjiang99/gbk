import SwiftUI

struct FeedCardView: View {
    let share: Share
    let isPlaying: Bool
    let onTap: () -> Void

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
            VStack(alignment: .leading, spacing: 6) {
                Text(share.title).font(.title2.bold()).foregroundStyle(Theme.accent)
                Text("@\(share.owner)").font(.subheadline).foregroundStyle(.secondary)
                if let parent = share.parent {
                    Label("Remix of \(parent.title)", systemImage: "arrow.triangle.branch")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let forks = share.forks, forks > 0 {
                    Label("\(forks) remixes", systemImage: "arrow.triangle.branch").font(.caption)
                        .foregroundStyle(Theme.accent)
                }
            }
            .padding(24)
        }
        .padding(16)
        .contentShape(Rectangle())
        .onTapGesture(perform: onTap)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}
