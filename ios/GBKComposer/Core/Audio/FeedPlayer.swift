import AVFoundation
import Foundation

/// Plays the visible feed item's mp3, preloads the next one, and crossfades between items.
/// Crossfade matches web: 400 ms equal-power (outgoing gain cos(t·π/2), incoming sin(t·π/2)), started on scroll settle.
/// TODO: SF2Engine (sf2player-swift) playback later; sequencer + MIDI parsing to be copied from earsheet's Packages/SF2Player.
@MainActor
final class FeedPlayer: ObservableObject {
    static let crossfadeDuration: TimeInterval = 0.4
    private static let fadeStep: TimeInterval = 1.0 / 60.0

    @Published private(set) var currentSlug: String?
    @Published private(set) var isPlaying = false

    /// Two players so the outgoing item can fade out while the incoming one fades in.
    private var active = AVPlayer()
    private var standby = AVPlayer()
    private var preloaded: [String: AVPlayerItem] = [:]
    private var endObserver: NSObjectProtocol?
    private var fadeTask: Task<Void, Never>?
    /// Called once per new item started (used to count plays).
    var onStart: ((String) -> Void)?

    nonisolated static func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default)
        try? session.setActive(true)
    }

    /// Equal-power gains for progress t in 0...1: (outgoing, incoming).
    nonisolated static func equalPowerGains(_ t: Double) -> (out: Float, in: Float) {
        let c = min(max(t, 0), 1) * .pi / 2
        return (Float(cos(c)), Float(sin(c)))
    }

    init() {
        active.automaticallyWaitsToMinimizeStalling = true
        standby.automaticallyWaitsToMinimizeStalling = true
    }

    /// Call when the feed's scroll position settles on `slug`.
    func play(slug: String, url: URL, next: (slug: String, url: URL)?) {
        if currentSlug != slug {
            let item = preloaded.removeValue(forKey: slug) ?? AVPlayerItem(url: url)
            let outgoing = active
            let incoming = standby
            fadeTask?.cancel()
            incoming.replaceCurrentItem(with: item)
            incoming.volume = currentSlug == nil ? 1 : 0
            incoming.play()
            active = incoming
            standby = outgoing
            let hadPrevious = currentSlug != nil && isPlaying
            currentSlug = slug
            onStart?(slug)
            loopOnEnd(item, player: incoming)
            if hadPrevious { crossfade(from: outgoing, to: incoming) } else { outgoing.pause(); incoming.volume = 1 }
        } else {
            active.play()
        }
        isPlaying = true
        if let next { preload(slug: next.slug, url: next.url) }
    }

    private func crossfade(from outgoing: AVPlayer, to incoming: AVPlayer) {
        fadeTask = Task { @MainActor [weak self] in
            let start = Date()
            while !Task.isCancelled {
                let t = Date().timeIntervalSince(start) / Self.crossfadeDuration
                let g = Self.equalPowerGains(t)
                outgoing.volume = g.out
                incoming.volume = g.in
                if t >= 1 { break }
                try? await Task.sleep(nanoseconds: UInt64(Self.fadeStep * 1_000_000_000))
            }
            // Finished or superseded: silence the outgoing player either way.
            outgoing.pause()
            outgoing.volume = 0
            outgoing.replaceCurrentItem(with: nil)
            if !Task.isCancelled { incoming.volume = 1 }
            _ = self
        }
    }

    private func loopOnEnd(_ item: AVPlayerItem, player: AVPlayer) {
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak player] _ in
                Task { @MainActor in
                    player?.seek(to: .zero)
                    player?.play()
                }
            }
    }

    func preload(slug: String, url: URL) {
        guard preloaded[slug] == nil, slug != currentSlug else { return }
        let asset = AVURLAsset(url: url)
        let item = AVPlayerItem(asset: asset)
        item.preferredForwardBufferDuration = 5
        preloaded = [slug: item]
        Task { _ = try? await asset.load(.isPlayable) }
    }

    func toggle() {
        if isPlaying { active.pause() } else { active.play() }
        isPlaying.toggle()
    }

    func pause() {
        fadeTask?.cancel()
        active.pause()
        standby.pause()
        isPlaying = false
    }
}
