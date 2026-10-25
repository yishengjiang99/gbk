import AVFoundation
import Foundation

/// Plays the visible feed item's mp3, preloads the next one, and crossfades between items.
/// Song switch (Yisheng, 2026-10-25): the next song starts immediately at full volume; only the outgoing song
/// fades out, over exactly 58 ms with gain cos(t·π/2). Started on scroll settle.
/// TODO: SF2Engine (sf2player-swift) playback later; sequencer + MIDI parsing to be copied from earsheet's Packages/SF2Player.
@MainActor
final class FeedPlayer: ObservableObject {
    static let crossfadeDuration: TimeInterval = 0.058
    private static let fadeStep: TimeInterval = 1.0 / 240.0 // ~4 ms steps so the 58 ms fade is smooth

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
    /// Spectrum for the active item; cards pull from it per frame.
    let analyzer = SpectrumAnalyzer()
    private var tapTask: Task<Void, Never>?
    private var pcmTask: Task<Void, Never>?

    nonisolated static func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default)
        try? session.setActive(true)
    }

    /// Outgoing gain for fade progress t in 0...1 (cos curve). The incoming song is always at 1.
    nonisolated static func fadeOutGain(_ t: Double) -> Float {
        Float(cos(min(max(t, 0), 1) * .pi / 2))
    }
    /// Incoming gain: full volume from the first frame (no fade-in).
    nonisolated static let incomingGain: Float = 1

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
            incoming.volume = Self.incomingGain
            incoming.play()
            active = incoming
            standby = outgoing
            let hadPrevious = currentSlug != nil && isPlaying
            currentSlug = slug
            onStart?(slug)
            loopOnEnd(item, player: incoming)
            attachTap(to: item, url: url)
            if hadPrevious { fadeOut(outgoing) } else { outgoing.pause() }
        } else {
            active.play()
        }
        isPlaying = true
        if let next { preload(slug: next.slug, url: next.url) }
    }

    /// Fade only the outgoing player; a newer switch cancels this and silences it at once.
    private func fadeOut(_ outgoing: AVPlayer) {
        fadeTask = Task { @MainActor in
            let start = Date()
            while !Task.isCancelled {
                let t = Date().timeIntervalSince(start) / Self.crossfadeDuration
                outgoing.volume = Self.fadeOutGain(t)
                if t >= 1 { break }
                try? await Task.sleep(nanoseconds: UInt64(Self.fadeStep * 1_000_000_000))
            }
            outgoing.pause()
            outgoing.volume = 0
            outgoing.replaceCurrentItem(with: nil)
        }
    }

    /// Seconds into the active item, read directly from AVPlayer (no published state). nil when `slug` isn't active.
    func currentSeconds(for slug: String) -> Double? {
        guard slug == currentSlug else { return nil }
        let t = CMTimeGetSeconds(active.currentTime())
        return t.isFinite ? t : nil
    }

    /// Duration of the active item once known.
    func durationSeconds(for slug: String) -> Double? {
        guard slug == currentSlug, let item = active.currentItem else { return nil }
        let d = CMTimeGetSeconds(item.duration)
        return d.isFinite && d > 0 ? d : nil
    }

    /// Install an MTAudioProcessingTap (via AVAudioMix) on the item's audio track for the spectrum.
    /// Also decodes the same mp3 so the spectrum still renders when the tap delivers nothing (seen on device).
    private func attachTap(to item: AVPlayerItem, url: URL) {
        tapTask?.cancel()
        pcmTask?.cancel()
        let sink = AudioTapSink()
        analyzer.sink = sink
        analyzer.pcm = nil
        analyzer.reset()
        tapTask = Task { @MainActor in
            guard let track = try? await item.asset.loadTracks(withMediaType: .audio).first, !Task.isCancelled,
                  let mix = sink.makeAudioMix(for: track) else { return }
            item.audioMix = mix
        }
        pcmTask = Task { @MainActor [analyzer] in
            let pcm = await DecodedPCM.load(url: url)
            guard !Task.isCancelled, analyzer.sink === sink else { return }
            analyzer.pcm = pcm
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
