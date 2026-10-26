// SPDX-License-Identifier: AGPL-3.0-or-later
#if canImport(AVFoundation)
import AVFoundation
import Combine
import Foundation

/// Playback position the UI can observe (`SF2MIDIPlayer.position`) to highlight notes.
public struct SF2PlaybackPosition: Equatable, Sendable {
    public var seconds: Double
    /// Fractional MIDI tick (via the song's tempo map).
    public var tick: Double
    public init(seconds: Double = 0, tick: Double = 0) { self.seconds = seconds; self.tick = tick }
}

/// Optional UI-supplied note positions (e.g. from the OMR note layout) keyed by the UI's own ids.
public struct SF2NotePosition: Hashable, Sendable {
    public var id: Int
    public var startTick: Int
    public var endTick: Int
    public init(id: Int, startTick: Int, endTick: Int) { self.id = id; self.startTick = startTick; self.endTick = endTick }
}

/// A–B practice loop in song seconds (`start < end`).
public struct SF2LoopRange: Equatable, Sendable {
    public var start: Double
    public var end: Double
    public init(start: Double, end: Double) { self.start = start; self.end = end }
}

/// A note-carrying SMF track the UI can mute (e.g. one staff / hand of a scan).
public struct SF2TrackInfo: Equatable, Sendable, Identifiable {
    public var id: Int { index }
    /// SMF track index (the conductor track 0 never has notes in OMR files).
    public var index: Int
    public var name: String
    public var noteCount: Int
    public init(index: Int, name: String, noteCount: Int) { self.index = index; self.name = name; self.noteCount = noteCount }
}

/// Real-time SoundFont MIDI player: AVAudioEngine + AVAudioSourceNode driving `SF2RealtimeCore`.
/// The render block only calls `SF2RealtimeCore.render` (preallocated voices, lock-free command
/// ring); all parsing, region building and allocation happen on the main actor or a background task.
@MainActor
public final class SF2MIDIPlayer: ObservableObject {
    public enum PlayerError: Error, Equatable {
        case soundFontNotLoaded
        case noSequence
        case audio(String)
    }

    @Published public private(set) var position = SF2PlaybackPosition()
    @Published public private(set) var isPlaying = false
    @Published public private(set) var duration: Double = 0
    /// Ids from `notePositions` sounding at `position.tick`.
    @Published public private(set) var activeNoteIDs: Set<Int> = []
    /// Playback speed (0.5 = half speed). Clamped to 0.25...4. Pitch is unchanged.
    @Published public var tempoScale: Double = 1 {
        didSet {
            let c = min(4, max(0.25, tempoScale.isFinite ? tempoScale : 1))
            if c != tempoScale { tempoScale = c; return }
            core?.setTempoScale(c)
        }
    }
    /// General MIDI program (0-127, bank 0) for every track; nil = the file's own instruments.
    /// Changing it recompiles the schedule and keeps the position / play state.
    @Published public var program: Int? {
        didSet {
            if let p = program, !(0 ... 127).contains(p) { program = min(127, max(0, p)); return }
            if program != oldValue { recompileKeepingPosition() }
        }
    }
    /// Semitones added to every note (GM drum channel excluded), clamped to -24...24. Changing it
    /// recompiles the schedule and keeps the position / play state.
    @Published public var transpose: Int = 0 {
        didSet {
            let c = min(24, max(-24, transpose))
            if c != transpose { transpose = c; return }
            if transpose != oldValue { recompileKeepingPosition() }
        }
    }
    /// Engine rendering rules. `.spec` (default): SoundFont 2.04 modulators, the file's CC1/7/10/11 and
    /// pitch bend, filter Q, GM drums on channel 10. `.gbk`: gbk's bit-exact export render.
    /// Changing it recompiles the schedule and keeps the position / play state.
    @Published public var fidelity: SF2Fidelity = .spec {
        didSet { if fidelity != oldValue { recompileKeepingPosition() } }
    }
    /// SMF track indices whose notes are silent (per song; cleared when another MIDI loads).
    @Published public private(set) var mutedTracks: Set<Int> = []
    /// Active A–B loop (per song).
    @Published public private(set) var loop: SF2LoopRange?
    /// Tracks with notes in the loaded song, in file order.
    public var noteTracks: [SF2TrackInfo] {
        (song?.tracks ?? []).filter { !$0.notes.isEmpty }.map { SF2TrackInfo(index: $0.index, name: $0.name, noteCount: $0.notes.count) }
    }
    public var notePositions: [SF2NotePosition] = [] {
        didSet { updateActiveNotes() }
    }
    /// Seconds the speaker lags the render clock while playing; `activeNoteIDs` use the audible
    /// position (render position minus this, in song time). nil = the audio session's
    /// `outputLatency + ioBufferDuration` (iOS), 0 elsewhere.
    public var outputLatencyOverride: Double?
    /// Live output level (lock-free, drained by the UI at ~30 Hz via `meter.update(now:)`).
    public let meter = SF2LevelMeter()
    /// Called on the main actor when playback reaches the end of the song (not on stop/pause).
    public var onFinished: (@MainActor () -> Void)?
    public private(set) var soundFont: SF2SoundFont?
    public private(set) var song: SMFSong?

    /// Exposed for hosts that tap the output (spectrum/waveform) or fade the mixer.
    public let engine = AVAudioEngine()
    /// false: the host owns AVAudioSession (gbk: AudioSessionController); the player never sets the category.
    public var managesAudioSession = true
    /// Post-master-bus trim applied on the main mixer (dB), e.g. toward a loudness target.
    public var outputGainDb: Double = 0 { didSet { applyOutputGain() } }
    /// Extra linear factor on top of `outputGainDb` (crossfades).
    public var fadeGain: Float = 1 { didSet { applyOutputGain() } }
    private func applyOutputGain() {
        engine.mainMixerNode.outputVolume = fadeGain * Float(pow(10, outputGainDb / 20))
    }
    private var sourceNode: AVAudioSourceNode?
    private var core: SF2RealtimeCore?
    private var sequence: SF2CompiledSequence?
    private var timer: Timer?
    private var observers: [NSObjectProtocol] = []
    private var resumeAfterInterruption = false
    private var idleStopWork: DispatchWorkItem?

    public init() {
        installObservers()
    }

    /// Shares an already-parsed bank (parse it once at launch).
    public convenience init(soundFont sf: SF2SoundFont) {
        self.init()
        soundFont = sf
    }

    deinit {
        timer?.invalidate()
        engine.stop()
        for o in observers { NotificationCenter.default.removeObserver(o) }
    }

    // MARK: Loading

    /// Parses the SoundFont once, off the main thread. Recompiles a loaded MIDI against it.
    public func load(soundFont url: URL) async throws {
        let sf = try await SF2SoundFont.load(contentsOf: url)
        soundFont = sf
        if song != nil { try compile() }
    }

    /// Uses an already-parsed bank (shared across players).
    public func load(soundFont sf: SF2SoundFont) throws {
        soundFont = sf
        if song != nil { try compile() }
    }

    /// Parses SMF (format 0/1) and prepares its sample-accurate schedule. Stops current playback.
    public func load(midi: Data) throws {
        let parsed = try SMFSong(data: midi)
        mutedTracks = []
        loop = nil
        guard soundFont != nil else { song = parsed; throw PlayerError.soundFontNotLoaded }
        song = parsed
        try compile()
    }

    private func compile() throws {
        guard let sf = soundFont, let song else { return }
        let c = try prepareCore()
        let plan = try SF2SequenceBuilder.plan(song: song, soundFont: sf, sampleRate: c.sampleRate, programOverride: program,
                                               transpose: transpose, fidelity: fidelity)
        let seq = SF2CompiledSequence(plan: plan)
        sequence = seq
        c.setSequence(seq)
        c.setTempoScale(tempoScale)
        c.setMutedTracks(mutedTracks)
        if let loop { c.setLoop(startSeconds: loop.start, endSeconds: loop.end) } else { c.clearLoop() }
        duration = song.durationSec
        isPlaying = false
        position = SF2PlaybackPosition()
        activeNoteIDs = []
    }

    private func recompileKeepingPosition() {
        guard song != nil, soundFont != nil else { return }
        let wasPlaying = isPlaying
        let at = position.seconds
        do {
            try compile()
            if at > 0 { seek(to: at) }
            if wasPlaying { play() }
        } catch {
            isPlaying = false
        }
    }

    // MARK: Transport

    public func play() {
        guard sequence != nil, let core else { return }
        do {
            try startEngine()
        } catch {
            return
        }
        idleStopWork?.cancel()
        core.play()
        isPlaying = true
        startTimer()
    }

    /// Master-bus input gain (dB, before compressor + limiter); used by the host's loudness AGC.
    public func setMasterGainDb(_ db: Double) { core?.setMasterGainDb(db) }

    public func pause() {
        core?.pause()
        isPlaying = false
        poll()
        scheduleIdleStop()
    }

    public func stop() {
        core?.stop()
        isPlaying = false
        position = SF2PlaybackPosition()
        activeNoteIDs = []
        scheduleIdleStop()
    }

    public func seek(to seconds: Double) {
        guard let core else { return }
        let s = max(0, min(seconds, duration))
        core.seek(toSeconds: s)
        position = SF2PlaybackPosition(seconds: s, tick: song?.secToTick(s) ?? 0)
        updateActiveNotes()
    }

    /// Updates `position` / `activeNoteIDs` from the audio clock now (the 30 Hz timer does this
    /// automatically while playing).
    public func refreshPosition() {
        poll()
    }

    // MARK: Audio graph

    private func outputSampleRate() -> Double {
        let sr = engine.outputNode.outputFormat(forBus: 0).sampleRate
        return sr > 0 ? sr : 44100
    }

    private func configureSession() throws {
        #if os(iOS) || os(tvOS) || os(visionOS)
        guard managesAudioSession else { return }
        let s = AVAudioSession.sharedInstance()
        do {
            try s.setCategory(.playback, mode: .default, options: [])
            try s.setActive(true)
        } catch {
            throw PlayerError.audio("AVAudioSession: \(error)")
        }
        #endif
    }

    /// Creates (or reuses) the core + source node at the current output sample rate.
    private func prepareCore() throws -> SF2RealtimeCore {
        try configureSession()
        let sr = outputSampleRate()
        if let core, core.sampleRate == sr { return core }
        teardownGraph()
        let c = SF2RealtimeCore(sampleRate: sr)
        let format = AVAudioFormat(standardFormatWithSampleRate: sr, channels: 2)!
        let node = AVAudioSourceNode(format: format, renderBlock: Self.makeRenderBlock(c))
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        engine.prepare()
        applyOutputGain()
        sourceNode = node
        core = c
        meter.core = c
        return c
    }

    /// Built outside the main actor so the audio-thread closure carries no actor isolation.
    private nonisolated static func makeRenderBlock(_ core: SF2RealtimeCore) -> AVAudioSourceNodeRenderBlock {
        return { _, _, frameCount, abl -> OSStatus in
            let buffers = UnsafeMutableAudioBufferListPointer(abl)
            guard buffers.count >= 2,
                  let l = buffers[0].mData?.assumingMemoryBound(to: Float.self),
                  let r = buffers[1].mData?.assumingMemoryBound(to: Float.self) else { return noErr }
            core.render(l, r, Int(frameCount))
            return noErr
        }
    }

    private func teardownGraph() {
        if let node = sourceNode {
            engine.stop()
            engine.detach(node)
        }
        sourceNode = nil
        core = nil
        meter.core = nil
    }

    private func startEngine() throws {
        if engine.isRunning { return }
        try configureSession()
        do { try engine.start() } catch { throw PlayerError.audio("AVAudioEngine.start: \(error)") }
    }

    private func scheduleIdleStop() {
        idleStopWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            Task { @MainActor in
                guard let self, !self.isPlaying else { return }
                self.engine.pause()
                self.stopTimer()
            }
        }
        idleStopWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0, execute: work)
    }

    /// Output route / sample-rate change: rebuild at the new rate, keep position, resume if playing.
    private func rebuildGraph() {
        guard song != nil, soundFont != nil else { teardownGraph(); return }
        let wasPlaying = isPlaying
        let at = position.seconds
        teardownGraph()
        do {
            try compile()
            core?.seek(toSeconds: at)
            position = SF2PlaybackPosition(seconds: at, tick: song?.secToTick(at) ?? 0)
            if wasPlaying { play() }
        } catch {
            isPlaying = false
        }
    }

    // MARK: Position polling

    private func startTimer() {
        guard timer == nil else { return }
        let t = Timer(timeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    private func poll() {
        guard let core else { return }
        core.drainRetired()
        let s = min(core.positionSeconds, max(duration, 0))
        let p = SF2PlaybackPosition(seconds: s, tick: song?.secToTick(s) ?? 0)
        if p != position { position = p }
        updateActiveNotes()
        if isPlaying && core.isFinished {
            isPlaying = false
            scheduleIdleStop()
            onFinished?()
        }
    }

    /// Wall-clock seconds between rendering a frame and hearing it.
    public var outputLatency: Double {
        if let o = outputLatencyOverride { return max(0, o) }
        #if os(iOS) || os(tvOS) || os(visionOS)
        let s = AVAudioSession.sharedInstance()
        let l = s.outputLatency + s.ioBufferDuration
        return l.isFinite ? max(0, min(l, 1)) : 0
        #else
        return 0
        #endif
    }

    /// Tick being heard now: `position.tick` when paused, earlier by `outputLatency` (scaled by
    /// tempo) while playing.
    public var audibleTick: Double {
        guard isPlaying, let song else { return position.tick }
        let lag = outputLatency * tempoScale
        return lag > 0 ? song.secToTick(max(0, position.seconds - lag)) : position.tick
    }

    // MARK: Practice: mute / solo, A–B loop

    public func setMuted(_ track: Int, _ muted: Bool) {
        var m = mutedTracks
        if muted { m.insert(track) } else { m.remove(track) }
        setMutedTracks(m)
    }

    public func setMutedTracks(_ tracks: Set<Int>) {
        guard tracks != mutedTracks else { return }
        mutedTracks = tracks
        core?.setMutedTracks(tracks)
    }

    /// Only `track` sounds (nil = all tracks).
    public func solo(_ track: Int?) {
        guard let track else { setMutedTracks([]); return }
        setMutedTracks(Set(noteTracks.map(\.index).filter { $0 != track }))
    }

    /// Loops [start, end) seconds (ordered, clamped to the song); an empty range clears it.
    public func setLoop(start: Double, end: Double) {
        let a = max(0, min(start, end)), b = min(max(start, end), duration)
        guard b - a >= 0.05 else { clearLoop(); return }
        let r = SF2LoopRange(start: a, end: b)
        loop = r
        core?.setLoop(startSeconds: a, endSeconds: b)
        if position.seconds < a || position.seconds >= b { seek(to: a) }
    }

    public func clearLoop() {
        guard loop != nil else { return }
        loop = nil
        core?.clearLoop()
    }

    /// Seek to a MIDI tick of the loaded song (e.g. a tapped note's onset).
    public func seek(toTick tick: Int) {
        guard let song else { return }
        seek(to: song.tickToSec(max(0, tick)))
    }

    /// Ids in `notePositions` sounding at `tick` (half-open [start, end)).
    public nonisolated static func activeIDs(_ positions: [SF2NotePosition], at tick: Double) -> Set<Int> {
        Set(positions.filter { Double($0.startTick) <= tick && tick < Double($0.endTick) }.map(\.id))
    }

    private func updateActiveNotes() {
        guard !notePositions.isEmpty else { if !activeNoteIDs.isEmpty { activeNoteIDs = [] }; return }
        let t = audibleTick
        let ids = Self.activeIDs(notePositions, at: t)
        if ids != activeNoteIDs { activeNoteIDs = ids }
    }

    // MARK: Session notifications

    private func installObservers() {
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.rebuildGraph() }
        })
        #if os(iOS) || os(tvOS) || os(visionOS)
        observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let info = note.userInfo ?? [:]
            let type = (info[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init(rawValue:))
            let opts = AVAudioSession.InterruptionOptions(rawValue: (info[AVAudioSessionInterruptionOptionKey] as? UInt) ?? 0)
            Task { @MainActor in self?.handleInterruption(type, opts) }
        })
        observers.append(nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            let raw = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) ?? 0
            let reason = AVAudioSession.RouteChangeReason(rawValue: raw)
            Task { @MainActor in
                // Headphones unplugged: pause (Apple HIG).
                if reason == .oldDeviceUnavailable { self?.pause() }
            }
        })
        observers.append(nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.rebuildGraph() }
        })
        #endif
    }

    #if os(iOS) || os(tvOS) || os(visionOS)
    private func handleInterruption(_ type: AVAudioSession.InterruptionType?, _ options: AVAudioSession.InterruptionOptions) {
        switch type {
        case .began:
            resumeAfterInterruption = isPlaying
            if isPlaying { pause() }
        case .ended:
            if resumeAfterInterruption && options.contains(.shouldResume) {
                try? AVAudioSession.sharedInstance().setActive(true)
                play()
            }
            resumeAfterInterruption = false
        default:
            break
        }
    }
    #endif
}
#endif
