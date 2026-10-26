import Accelerate
import AVFoundation
import Foundation
import os
import QuartzCore
import SF2Player

/// Feed playback: every song is its MIDI (`media.midi`) sequenced live through SF2Engine (sf2player-swift 6ce4941,
/// GeneralUser GS 2.0.2) on AVAudioEngine, with the engine's reverb/chorus (CC91/93) applied in real time.
/// Nothing is prerendered and no MP3/WAV is played. Output level matches web live playback: no LUFS
/// normalization and no compressor/limiter, just a fixed 0.8 headroom gain (`headroomGain`).
/// Song switch (Yisheng, 2026-10-25): the next song starts immediately at full volume; only the outgoing song
/// fades out, over exactly 58 ms with gain cos(t·π/2). Started on scroll settle.
/// The spectrum + waveform read a tap on the playing engine's main mixer output.
@MainActor
final class FeedPlayer: ObservableObject {
    static let crossfadeDuration: TimeInterval = 0.058
    private static let fadeStep: TimeInterval = 1.0 / 240.0
    nonisolated private static let log = Logger(subsystem: "com.grepawk.moviefone", category: "FeedPlayer")

    @Published private(set) var currentSlug: String?
    @Published private(set) var isPlaying = false
    /// Seconds from `play(slug:)` to the first non-silent tap block of that song (see `timeToFirstAudio` log).
    @Published private(set) var lastTimeToFirstAudio: Double?

    /// Two live players (A/B) so the outgoing song can fade while the incoming one starts.
    private var active: SF2MIDIPlayer?
    private var standby: SF2MIDIPlayer?
    private var midiCache: [String: Data] = [:]
    private var midiLoads: [String: Task<Data?, Never>] = [:]
    private var fadeTask: Task<Void, Never>?
    private var startTask: Task<Void, Never>?
    var onStart: ((String) -> Void)?
    let analyzer = SpectrumAnalyzer()
    private var scope = OutputScope()

    @MainActor static func configureAudioSession() { AudioSessionController.shared.start() }

    nonisolated static func fadeOutGain(_ t: Double) -> Float {
        Float(cos(min(max(t, 0), 1) * .pi / 2))
    }
    nonisolated static let incomingGain: Float = 1
    /// Web live playback's fixed headroom gain (GBK Social, 2026-10-25). Applied as the SF2 master gain.
    nonisolated static let headroomGain: Double = 0.8
    nonisolated static var headroomGainDb: Double { 20 * log10(headroomGain) }

    init() {}

    private func makePlayer(_ sf: SF2SoundFont) -> SF2MIDIPlayer {
        let p = SF2MIDIPlayer(soundFont: sf)
        p.managesAudioSession = false // AudioSessionController owns the session (.playback, loudspeaker)
        p.fidelity = .spec
        p.onFinished = { [weak p] in p?.seek(to: 0); p?.play() } // loop like the old feed
        return p
    }

    private func midi(slug: String, url: URL) -> Task<Data?, Never> {
        if let d = midiCache[slug] { return Task { d } }
        if let t = midiLoads[slug] { return t }
        let t = Task<Data?, Never> {
            if url.isFileURL { return try? Data(contentsOf: url) }
            guard let (d, r) = try? await URLSession.shared.data(from: url),
                  (r as? HTTPURLResponse)?.statusCode ?? 200 == 200 else { return nil }
            return d
        }
        midiLoads[slug] = t
        return t
    }

    /// Call when the feed's scroll position settles on `slug`. `url` is the song's MIDI.
    func play(slug: String, url: URL, next: (slug: String, url: URL)?) {
        if currentSlug != slug {
            startTask?.cancel()
            let requested = CACurrentMediaTime()
            let outgoing = active
            currentSlug = slug
            onStart?(slug)
            let midiTask = midi(slug: slug, url: url)
            let sfTask = SoundFontStore.shared.load()
            startTask = Task { @MainActor [weak self] in
                guard let sf = await sfTask.value, let data = await midiTask.value,
                      !Task.isCancelled, let self, self.currentSlug == slug else { return }
                self.midiLoads[slug] = nil
                self.midiCache[slug] = data
                self.start(data: data, soundFont: sf, slug: slug, requested: requested, outgoing: outgoing)
            }
        } else if !isPlaying {
            AudioSessionController.shared.start()
            active?.play()
        }
        isPlaying = true
        if let next { preload(slug: next.slug, url: next.url) }
    }

    private func start(data: Data, soundFont sf: SF2SoundFont, slug: String, requested: CFTimeInterval, outgoing: SF2MIDIPlayer?) {
        let incoming = (standby.flatMap { $0 === outgoing ? nil : $0 }) ?? makePlayer(sf)
        removeTap(incoming)
        do { try incoming.load(midi: data) } catch {
            Self.log.error("MIDI load failed for \(slug, privacy: .public): \(String(describing: error), privacy: .public)")
            return
        }
        incoming.fadeGain = Self.incomingGain
        incoming.setMasterDynamicsEnabled(false)
        incoming.setMasterGainDb(Self.headroomGainDb)
        let scope = OutputScope()
        self.scope = scope
        analyzer.reset()
        analyzer.source = scope
        installTap(on: incoming, scope: scope, slug: slug, requested: requested)
        AudioSessionController.shared.start()
        if isPlaying { incoming.play() }
        fadeTask?.cancel()
        if let outgoing, outgoing !== incoming { fadeOut(outgoing) }
        standby = outgoing
        active = incoming
    }

    /// Tap on the engine's output: feeds the spectrum/waveform scope and the first-audio timer.
    private func installTap(on p: SF2MIDIPlayer, scope: OutputScope, slug: String, requested: CFTimeInterval) {
        let block = Self.makeTapBlock(scope: scope,
            onFirstAudio: { [weak self] in
                let dt = CACurrentMediaTime() - requested
                Task { @MainActor in
                    Self.log.info("timeToFirstAudio \(slug, privacy: .public) \(dt, format: .fixed(precision: 3))s")
                    if self?.currentSlug == slug { self?.lastTimeToFirstAudio = dt }
                }
            })
        p.engine.mainMixerNode.installTap(onBus: 0, bufferSize: 1024, format: nil, block: block)
    }

    /// Built outside the main actor: the block runs on the audio tap thread.
    nonisolated static func makeTapBlock(scope: OutputScope,
                                         onFirstAudio: @escaping () -> Void) -> AVAudioNodeTapBlock {
        var reported = false
        return { buffer, _ in
            scope.push(buffer)
            guard let ch = buffer.floatChannelData, buffer.format.channelCount >= 1 else { return }
            let n = Int(buffer.frameLength)
            guard n > 0 else { return }
            if !reported {
                var peak: Float = 0
                vDSP_maxmgv(ch[0], 1, &peak, vDSP_Length(n))
                if peak > 1e-4 { reported = true; onFirstAudio() }
            }
        }
    }

    private func removeTap(_ p: SF2MIDIPlayer) { p.engine.mainMixerNode.removeTap(onBus: 0) }

    private func fadeOut(_ outgoing: SF2MIDIPlayer) {
        removeTap(outgoing)
        fadeTask = Task { @MainActor in
            let start = Date()
            while !Task.isCancelled {
                let t = Date().timeIntervalSince(start) / Self.crossfadeDuration
                outgoing.fadeGain = Self.fadeOutGain(t)
                if t >= 1 { break }
                try? await Task.sleep(nanoseconds: UInt64(Self.fadeStep * 1_000_000_000))
            }
            outgoing.stop()
            outgoing.fadeGain = 0
        }
    }

    /// Song seconds of the active item from the real-time core's clock. nil when `slug` isn't active.
    func currentSeconds(for slug: String) -> Double? {
        guard slug == currentSlug, let p = active else { return nil }
        p.refreshPosition()
        return p.position.seconds
    }

    func durationSeconds(for slug: String) -> Double? {
        guard slug == currentSlug, let d = active?.duration, d > 0 else { return nil }
        return d
    }

    func preload(slug: String, url: URL) {
        guard midiCache[slug] == nil, midiLoads[slug] == nil, slug != currentSlug else { return }
        midiCache = midiCache.filter { $0.key == currentSlug }
        let t = midi(slug: slug, url: url)
        Task { @MainActor [weak self] in
            if let d = await t.value { self?.midiCache[slug] = d }
            self?.midiLoads[slug] = nil
        }
    }

    func toggle() {
        if isPlaying { active?.pause() } else { AudioSessionController.shared.start(); active?.play() }
        isPlaying.toggle()
    }

    func pause() {
        fadeTask?.cancel()
        active?.pause()
        standby?.stop()
        isPlaying = false
    }
}


/// Drives the real SF2 core block-by-block (like the audio thread) through the same tap block the feed installs,
/// for tests and diagnostics. Not a prerender for playback: output goes only to the scope.
enum LiveRenderProbe {
    struct Result { let scope: OutputScope; let sawAudio: Bool }

    static func run(midi: Data, soundFont url: URL, seconds: Double, sampleRate rate: Double = 48_000, block: Int = 1024) throws -> Result {
        let sf = try SF2SoundFont(data: Data(contentsOf: url, options: .mappedIfSafe), options: .lenient)
        let song = try SMFSong(data: midi)
        let plan = try SF2SequenceBuilder.plan(song: song, soundFont: sf, sampleRate: rate, fidelity: .spec)
        let core = SF2RealtimeCore(sampleRate: rate)
        core.setSequence(SF2CompiledSequence(plan: plan))
        core.setMasterDynamicsEnabled(false)
        core.setMasterGainDb(FeedPlayer.headroomGainDb)
        core.play()
        let scope = OutputScope()
        var saw = false
        let tap = FeedPlayer.makeTapBlock(scope: scope, onFirstAudio: { saw = true })
        guard let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 2) else { return Result(scope: scope, sawAudio: false) }
        for i in 0..<Int(rate * seconds) / block {
            guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(block)),
                  let ch = buf.floatChannelData else { break }
            buf.frameLength = AVAudioFrameCount(block)
            core.render(ch[0], ch[1], block)
            tap(buf, AVAudioTime(sampleTime: AVAudioFramePosition(i * block), atRate: rate))
        }
        return Result(scope: scope, sawAudio: saw)
    }
}
