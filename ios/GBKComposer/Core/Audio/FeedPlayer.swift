import AVFoundation
import Foundation

/// Plays the visible feed item's mp3 and preloads the next one.
@MainActor
final class FeedPlayer: ObservableObject {
    @Published private(set) var currentSlug: String?
    @Published private(set) var isPlaying = false

    private let player = AVPlayer()
    private var preloaded: [String: AVPlayerItem] = [:]
    private var endObserver: NSObjectProtocol?

    nonisolated static func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default)
        try? session.setActive(true)
    }

    init() {
        player.automaticallyWaitsToMinimizeStalling = true
    }

    func play(slug: String, url: URL, next: (slug: String, url: URL)?) {
        if currentSlug != slug {
            let item = preloaded.removeValue(forKey: slug) ?? AVPlayerItem(url: url)
            player.replaceCurrentItem(with: item)
            currentSlug = slug
            if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
            endObserver = NotificationCenter.default.addObserver(
                forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
                    Task { @MainActor in
                        self?.player.seek(to: .zero)
                        self?.player.play()
                    }
                }
        }
        player.play()
        isPlaying = true
        if let next { preload(slug: next.slug, url: next.url) }
    }

    func preload(slug: String, url: URL) {
        guard preloaded[slug] == nil, slug != currentSlug else { return }
        let asset = AVURLAsset(url: url)
        let item = AVPlayerItem(asset: asset)
        item.preferredForwardBufferDuration = 5
        preloaded = [slug: item] // keep only one preloaded item
        Task { _ = try? await asset.load(.isPlayable) }
    }

    func toggle() {
        if isPlaying { player.pause() } else { player.play() }
        isPlaying.toggle()
    }

    func pause() {
        player.pause()
        isPlaying = false
    }
}
