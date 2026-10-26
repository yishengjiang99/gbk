import AVFoundation
import Foundation

/// Plays the visible feed item as lossless PCM through AVAudioEngine and preloads the next one.
/// Source is the song's WAV (`media.wav`); MP3 only when a song has no WAV, decoded to the same PCM path.
/// Song switch (Yisheng, 2026-10-25): the next song starts immediately at full volume; only the outgoing song
/// fades out, over exactly 58 ms with gain cos(t·π/2). Started on scroll settle.
/// The spectrum + waveform read the very buffer the AVAudioPlayerNode plays, at the node's sample clock.
@MainActor
final class FeedPlayer: ObservableObject {
    static let crossfadeDuration: TimeInterval = 0.058
    private static let fadeStep: TimeInterval = 1.0 / 240.0

    @Published private(set) var currentSlug: String?
    @Published private(set) var isPlaying = false

    private let engine = AVAudioEngine()
    /// Two nodes so the outgoing item can fade out while the incoming one plays.
    private var active = AVAudioPlayerNode()
    private var standby = AVAudioPlayerNode()
    private var activePCM: DecodedPCM?
    private var cache: [String: DecodedPCM] = [:]
    private var loads: [String: Task<DecodedPCM?, Never>] = [:]
    private var fadeTask: Task<Void, Never>?
    private var startTask: Task<Void, Never>?
    private var configObserver: NSObjectProtocol?
    /// Called once per new item started (used to count plays).
    var onStart: ((String) -> Void)?
    /// Spectrum for the active item; cards pull from it per frame.
    let analyzer = SpectrumAnalyzer()

    /// Session ownership lives in AudioSessionController (single owner; `.playback` unless something records).
    @MainActor static func configureAudioSession() { AudioSessionController.shared.start() }

    nonisolated static func fadeOutGain(_ t: Double) -> Float {
        Float(cos(min(max(t, 0), 1) * .pi / 2))
    }
    nonisolated static let incomingGain: Float = 1

    init() {
        engine.attach(active)
        engine.attach(standby)
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.recoverAfterConfigChange() }
            }
    }

    private func ensureRunning() {
        AudioSessionController.shared.start()
        guard !engine.isRunning else { return }
        engine.prepare()
        try? engine.start()
    }

    private func pcm(slug: String, url: URL) -> Task<DecodedPCM?, Never> {
        if let c = cache[slug] { return Task { c } }
        if let t = loads[slug] { return t }
        let t = Task<DecodedPCM?, Never> { try? await DecodedPCM.load(url: url) }
        loads[slug] = t
        return t
    }

    /// Call when the feed's scroll position settles on `slug`.
    func play(slug: String, url: URL, next: (slug: String, url: URL)?) {
        if currentSlug != slug {
            startTask?.cancel()
            let hadPrevious = currentSlug != nil && isPlaying
            let outgoing = active
            currentSlug = slug
            activePCM = nil
            analyzer.source = nil
            analyzer.reset()
            onStart?(slug)
            // Outgoing keeps playing until the new PCM is ready, then fades.
            let load = pcm(slug: slug, url: url)
            startTask = Task { @MainActor [weak self] in
                guard let pcm = await load.value, !Task.isCancelled, let self, self.currentSlug == slug else { return }
                self.loads[slug] = nil
                self.cache[slug] = pcm
                self.start(pcm, fadingOut: hadPrevious ? outgoing : nil)
            }
            if !hadPrevious { outgoing.stop() }
        } else if !isPlaying {
            ensureRunning()
            active.play()
        }
        isPlaying = true
        if let next { preload(slug: next.slug, url: next.url) }
    }

    private func start(_ pcm: DecodedPCM, fadingOut outgoing: AVAudioPlayerNode?) {
        guard let buffer = pcm.buffer else { return }
        fadeTask?.cancel()
        let incoming = (outgoing === active) ? standby : active
        engine.disconnectNodeOutput(incoming)
        engine.connect(incoming, to: engine.mainMixerNode, format: buffer.format)
        ensureRunning()
        incoming.stop()
        incoming.volume = Self.incomingGain
        incoming.scheduleBuffer(buffer, at: nil, options: .loops)
        if isPlaying { incoming.play() }
        if incoming !== active { standby = active; active = incoming }
        activePCM = pcm
        analyzer.source = pcm
        let slug = currentSlug
        analyzer.clock = { [weak self] in MainActor.assumeIsolated { slug.flatMap { self?.currentSeconds(for: $0) } } }
        if let outgoing, outgoing !== incoming { fadeOut(outgoing) } else { standby.stop() }
    }

    private func fadeOut(_ outgoing: AVAudioPlayerNode) {
        fadeTask = Task { @MainActor in
            let start = Date()
            while !Task.isCancelled {
                let t = Date().timeIntervalSince(start) / Self.crossfadeDuration
                outgoing.volume = Self.fadeOutGain(t)
                if t >= 1 { break }
                try? await Task.sleep(nanoseconds: UInt64(Self.fadeStep * 1_000_000_000))
            }
            outgoing.stop()
            outgoing.volume = 0
        }
    }

    /// Engine stopped by a route/config change (e.g. WebKit rewrote the session): restart and resume.
    private func recoverAfterConfigChange() {
        guard let pcm = activePCM, let buffer = pcm.buffer else { return }
        let resume = currentSlug.flatMap { currentSeconds(for: $0) } ?? 0
        engine.disconnectNodeOutput(active)
        engine.connect(active, to: engine.mainMixerNode, format: buffer.format)
        ensureRunning()
        active.stop()
        let startFrame = AVAudioFramePosition(resume * pcm.sampleRate)
        if startFrame > 0, startFrame < AVAudioFramePosition(buffer.frameLength),
           let tail = Self.slice(buffer, from: AVAudioFrameCount(startFrame)) {
            seekOffset = resume
            active.scheduleBuffer(tail) { [weak self] in Task { @MainActor in self?.restartLoop(buffer) } }
        } else {
            seekOffset = 0
            active.scheduleBuffer(buffer, at: nil, options: .loops)
        }
        if isPlaying { active.play() }
    }

    private var seekOffset: Double = 0
    private func restartLoop(_ buffer: AVAudioPCMBuffer) {
        guard activePCM?.buffer === buffer, engine.isRunning else { return }
        active.stop(); seekOffset = 0
        active.scheduleBuffer(buffer, at: nil, options: .loops)
        if isPlaying { active.play() }
    }

    private static func slice(_ b: AVAudioPCMBuffer, from start: AVAudioFrameCount) -> AVAudioPCMBuffer? {
        let n = b.frameLength - start
        guard let out = AVAudioPCMBuffer(pcmFormat: b.format, frameCapacity: n), let src = b.floatChannelData,
              let dst = out.floatChannelData else { return nil }
        for c in 0..<Int(b.format.channelCount) { dst[c].update(from: src[c] + Int(start), count: Int(n)) }
        out.frameLength = n
        return out
    }

    /// Seconds into the active item from the player node's sample clock (looping). nil when `slug` isn't active.
    func currentSeconds(for slug: String) -> Double? {
        guard slug == currentSlug, let pcm = activePCM, pcm.duration > 0,
              let nodeTime = active.lastRenderTime, let t = active.playerTime(forNodeTime: nodeTime) else { return nil }
        let s = Double(t.sampleTime) / t.sampleRate + seekOffset
        guard s.isFinite, s >= 0 else { return nil }
        return s.truncatingRemainder(dividingBy: pcm.duration)
    }

    func durationSeconds(for slug: String) -> Double? {
        guard slug == currentSlug, let d = activePCM?.duration, d > 0 else { return nil }
        return d
    }

    func preload(slug: String, url: URL) {
        guard cache[slug] == nil, loads[slug] == nil, slug != currentSlug else { return }
        // Keep memory bounded: the active song plus one preloaded.
        cache = cache.filter { $0.key == currentSlug }
        let t = pcm(slug: slug, url: url)
        Task { @MainActor [weak self] in
            if let p = await t.value { self?.cache[slug] = p }
            self?.loads[slug] = nil
        }
    }

    func toggle() {
        if isPlaying { active.pause() } else { ensureRunning(); active.play() }
        isPlaying.toggle()
    }

    func pause() {
        fadeTask?.cancel()
        active.pause()
        standby.stop()
        isPlaying = false
    }
}
