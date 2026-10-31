import Foundation
import Combine
import SF2Player

// Phase 5: the native Studio audio engine — a StudioTransportDriver over the shared
// SF2Player (bundled GeneralUser GS, .spec fidelity, the feed's headroom gain) plus the
// WorkstationHost capabilities (preset list, offline WAV render, downloads, SF2 regions
// for voice settings). Mirrors src/audio/renderer-host.ts: presets and track regions
// resolve exactly as the render does (program at tick 0, channel 10 -> bank 128,
// bank-0 fallback), so voice tools always describe the sound that actually plays.

final class StudioAudioDriver: StudioTransportDriver, @unchecked Sendable {
    private weak var store: WorkstationStore?
    private var player: SF2MIDIPlayer?
    private var previewPlayer: SF2MIDIPlayer?
    private var loadedKey: String?
    private var positionSub: AnyCancellable?
    private var projectSub: AnyCancellable?
    private var reloadTask: Task<Void, Never>?
    private let fontLock = NSLock()
    private var _font: SF2SoundFont?
    var font: SF2SoundFont? {
        fontLock.lock(); defer { fontLock.unlock() }; return _font
    }

    // MARK: - Install

    /// Wire the driver + host into the store (Create tab does this once for its Studio store).
    static func install(store: WorkstationStore) -> StudioAudioDriver {
        let d = StudioAudioDriver()
        d.store = store
        store.host.listPresets = { [weak d] in d?.presetsJSON() ?? [] }
        store.host.ensureSoundFont = { [weak d] in _ = await d?.ensureFont() }
        store.host.renderWav = { [weak d] project, normalize in
            guard let d else { throw ToolArgError("UNSUPPORTED", "audio engine unavailable") }
            return try await d.renderWav(project, normalize)
        }
        store.host.download = { data, name in StudioDownloads.save(data, name) }
        store.host.trackRegionsJSON = { [weak d] project, trackId in d?.trackRegionsJSON(project, trackId) }
        store.attachDriver(d)
        d.observeProject()
        return d
    }

    // MARK: - SoundFont

    @discardableResult
    func ensureFont() async -> SF2SoundFont? {
        if let f = font { return f }
        let f = await SoundFontStore.shared.load().value
        if let f { fontLock.lock(); _font = f; fontLock.unlock() }
        return f
    }

    @MainActor
    private func makePlayer(font: SF2SoundFont) -> SF2MIDIPlayer {
        let p = SF2MIDIPlayer(soundFont: font)
        p.managesAudioSession = false // AudioSessionController owns the session
        p.fidelity = .spec
        p.setMasterDynamicsEnabled(false)
        p.setMasterGainDb(FeedPlayer.headroomGainDb)
        return p
    }

    @MainActor
    private func ensurePlayer() async -> SF2MIDIPlayer? {
        if let player { return player }
        guard let font = await ensureFont() else { return nil }
        let p = makePlayer(font: font)
        p.onFinished = { [weak self] in
            self?.store?.updateTransport { $0.playing = false }
        }
        positionSub = p.$position
            .map { Int($0.tick.rounded()) }
            .removeDuplicates()
            .sink { [weak self] tick in self?.store?.updateTransport { $0.positionTick = tick } }
        player = p
        return p
    }

    // MARK: - StudioTransportDriver

    func isAudioReady() -> Bool { player != nil && font != nil }

    func prepare() async -> Bool {
        await MainActor.run { } // hop first so player creation is main-bound
        return await ensurePlayer() != nil
    }

    func unlock() {
        Task { @MainActor in AudioSessionController.shared.start() }
    }

    func play(fromTick: Int) async throws {
        guard let store else { throw ToolArgError("AUDIO_NOT_READY", "studio store unavailable") }
        guard let p = await ensurePlayer() else {
            throw ToolArgError("AUDIO_NOT_READY", "Audio engine not ready; the user must tap in the app to start audio and load a SoundFont.")
        }
        await MainActor.run {
            AudioSessionController.shared.start()
            self.loadIfNeeded(p, store.project)
            p.seek(toTick: fromTick)
            p.play()
        }
    }

    func pause() {
        Task { @MainActor [weak self] in self?.player?.pause() }
    }

    func stop() {
        Task { @MainActor [weak self] in self?.player?.stop() }
    }

    func seek(tick: Int) {
        Task { @MainActor [weak self] in self?.player?.seek(toTick: tick) }
    }

    func preview(project: Project, startTick: Int, endTick: Int) async throws {
        guard let font = await ensureFont() else {
            throw ToolArgError("AUDIO_NOT_READY", "Audio engine not ready; the user must tap in the app to start audio and load a SoundFont.")
        }
        let p = await MainActor.run { () -> SF2MIDIPlayer in
            if let previewPlayer { return previewPlayer }
            let np = self.makePlayer(font: font)
            self.previewPlayer = np
            return np
        }
        try await MainActor.run {
            AudioSessionController.shared.start()
            try p.load(midi: serializeSmf(project, soundNrpn: true))
            p.seek(toTick: startTick)
            p.play()
        }
        let maxWait = tickToSec(project, endTick) - tickToSec(project, startTick) + 5
        let deadline = Date().addingTimeInterval(max(1, maxWait))
        while Date() < deadline {
            try Task.checkCancellation()
            let done = await MainActor.run { !p.isPlaying || p.position.tick >= Double(endTick) }
            if done { break }
            try await Task.sleep(nanoseconds: 60_000_000)
        }
        await MainActor.run { p.stop() }
        if Task.isCancelled { throw ToolArgError("OPERATION_CANCELLED", "preview cancelled") }
    }

    // MARK: - Project loading / live re-sequence

    @MainActor
    private func loadIfNeeded(_ p: SF2MIDIPlayer, _ project: Project) {
        let key = "\(project.id):\(project.revision)"
        if loadedKey == key { return }
        do {
            try p.load(midi: serializeSmf(project, soundNrpn: true))
            loadedKey = key
            applyMixAndLoop(p, project)
        } catch {
            store?.log("user", "load project into player", false, String(describing: error))
        }
    }

    @MainActor
    private func applyMixAndLoop(_ p: SF2MIDIPlayer, _ project: Project) {
        // Track indices follow project order, as written to the SMF by serializeSmf.
        let anySolo = project.tracks.contains { $0.mix.solo }
        var muted = Set<Int>()
        for (i, t) in project.tracks.enumerated() {
            let m = store?.overrides[t.id].map { ov -> (mute: Bool, solo: Bool) in
                (mute: ov.mute ?? t.mix.mute, solo: ov.solo ?? t.mix.solo)
            } ?? (mute: t.mix.mute, solo: t.mix.solo)
            if anySolo ? !m.solo : m.mute { muted.insert(i) }
        }
        p.setMutedTracks(muted)
        if project.loop.enabled, project.loop.endTick > project.loop.startTick {
            p.setLoop(start: tickToSec(project, project.loop.startTick), end: tickToSec(project, project.loop.endTick))
        } else {
            p.clearLoop()
        }
    }

    /// While playing, an edit (user or agent) re-sequences the player at the current tick,
    /// debounced so a burst of ops reloads once.
    private func observeProject() {
        guard let store else { return }
        projectSub = store.$project
            .map { ($0.id, $0.revision) }
            .removeDuplicates { $0.0 == $1.0 && $0.1 == $1.1 }
            .debounce(for: .milliseconds(200), scheduler: DispatchQueue.main)
            .sink { [weak self] _ in
                guard let self, let store = self.store, store.transport.playing, let p = self.player else { return }
                Task { @MainActor [weak self] in
                    guard let self, let store = self.store, store.transport.playing else { return }
                    let tick = store.transport.positionTick
                    self.loadedKey = nil
                    self.loadIfNeeded(p, store.project)
                    p.seek(toTick: tick)
                    p.play()
                }
            }
    }

    // MARK: - Host: presets + regions (mirror of renderer-host.ts / offline-renderer.ts)

    func presetsJSON() -> [JSONValue] {
        guard let font else { return [] }
        return Array(font.presets).enumerated().map { index, h in
            .object([("index", .int(Int64(index))), ("bank", .int(Int64(h.bank))),
                     ("program", .int(Int64(h.preset))), ("name", .string(h.presetName))])
        }
    }

    /// The preset a track renders with: its program event at tick <= 0 (latest), channel
    /// 10 -> bank 128, else bankMsb; resolved with the engine's bank-0 fallback chain.
    func trackRegionsJSON(_ project: Project, _ trackId: String) -> JSONValue? {
        guard let font, let track = project.tracks.first(where: { $0.id == trackId }) else { return nil }
        let g = project.programs.filter { $0.trackId == trackId && $0.tick <= 0 }.max { $0.tick < $1.tick }
        let channel = g?.channel ?? track.channel
        let bank = channel == 9 ? 128 : (g?.bankMsb ?? 0)
        guard let index = font.resolvePresetIndex(program: g?.program ?? 0, bank: bank),
              let regions = try? font.buildRegionsForPreset(index, normalize: true, fidelity: .gbk) else { return nil }
        return .object([
            ("presetName", .string(font.presetName(index) ?? "")),
            ("presetIndex", .int(Int64(index))),
            ("regions", .array(regions.map(Self.regionJSON))),
        ])
    }

    private static func regionJSON(_ r: SF2Region) -> JSONValue {
        func env(_ e: SF2VolEnv) -> JSONValue {
            .object([("delayTc", .int(Int64(e.delayTc))), ("attackTc", .int(Int64(e.attackTc))),
                     ("holdTc", .int(Int64(e.holdTc))), ("decayTc", .int(Int64(e.decayTc))),
                     ("sustainCb", .int(Int64(e.sustainCb))), ("releaseTc", .int(Int64(e.releaseTc)))])
        }
        func env(_ e: SF2ModEnv) -> JSONValue {
            .object([("delayTc", .int(Int64(e.delayTc))), ("attackTc", .int(Int64(e.attackTc))),
                     ("holdTc", .int(Int64(e.holdTc))), ("decayTc", .int(Int64(e.decayTc))),
                     ("sustain", .number(e.sustain)), ("releaseTc", .int(Int64(e.releaseTc)))])
        }
        return .object([
            ("keyRange", .array([.int(Int64(r.keyRange.0)), .int(Int64(r.keyRange.1))])),
            ("velRange", .array([.int(Int64(r.velRange.0)), .int(Int64(r.velRange.1))])),
            ("sample", .object([("sampleRate", .int(Int64(r.sample.sampleRate))),
                                ("originalKey", .int(Int64(r.originalKey))),
                                ("overridingRootKey", r.overridingRootKey.map { .int(Int64($0)) } ?? .null)])),
            ("coarseTune", .int(Int64(r.coarseTune))), ("fineTune", .int(Int64(r.fineTune))),
            ("scaleTuning", .int(Int64(r.scaleTuning))),
            ("initialAttenuationCb", .int(Int64(r.initialAttenuationCb))), ("pan", .int(Int64(r.pan))),
            ("initialFilterFcCents", .int(Int64(r.initialFilterFcCents))), ("initialFilterQCb", .int(Int64(r.initialFilterQCb))),
            ("modEnvToFilterFcCents", .int(Int64(r.modEnvToFilterFcCents))), ("modLfoToFilterFcCents", .int(Int64(r.modLfoToFilterFcCents))),
            ("modLfoDelayTc", .int(Int64(r.modLfoDelayTc))), ("modLfoFreqCents", .int(Int64(r.modLfoFreqCents))),
            ("modLfoToPitchCents", .int(Int64(r.modLfoToPitchCents))),
            ("vibLfoDelayTc", .int(Int64(r.vibLfoDelayTc))), ("vibLfoFreqCents", .int(Int64(r.vibLfoFreqCents))),
            ("vibLfoToPitchCents", .int(Int64(r.vibLfoToPitchCents))),
            ("modEnvToPitchCents", .int(Int64(r.modEnvToPitchCents))), ("modLfoToVolumeCb", .int(Int64(r.modLfoToVolumeCb))),
            ("chorusSend", .int(Int64(r.chorusSend))), ("reverbSend", .int(Int64(r.reverbSend))),
            ("keynumToModEnvHold", .int(Int64(r.keynumToModEnvHold))), ("keynumToModEnvDecay", .int(Int64(r.keynumToModEnvDecay))),
            ("keynumToVolEnvHold", .int(Int64(r.keynumToVolEnvHold))), ("keynumToVolEnvDecay", .int(Int64(r.keynumToVolEnvDecay))),
            ("volEnv", env(r.volEnv)), ("modEnv", env(r.modEnv)),
            ("modulators", .array((r.modulators ?? []).map {
                .object([("dest", .int(Int64($0.dest))), ("src", .int(Int64($0.src))), ("amount", .int(Int64($0.amount)))])
            })),
        ])
    }

    // MARK: - Host: offline WAV render

    func renderWav(_ project: Project, _ normalize: String) async throws -> Data {
        guard let font = await ensureFont() else {
            throw ToolArgError("UNSUPPORTED", "SoundFont not available (renderer SoundFont failed to load)")
        }
        let midi = serializeSmf(project, soundNrpn: true)
        let buffer = try await Task.detached(priority: .userInitiated) {
            try SF2OfflineRenderer.render(midi: midi, soundFont: font, sampleRate: 44100, tailSec: 3, fidelity: .gbk)
        }.value
        return encodeWavPCM16(left: buffer.left, right: buffer.right, sampleRate: buffer.sampleRate, normalize: normalize)
    }
}

/// Tool-driven downloads land in the app's Documents/GBK Downloads folder (the native
/// equivalent of the browser download; the Studio UI can share them from there).
enum StudioDownloads {
    static func save(_ data: Data, _ filename: String) -> Bool {
        let safe = filename.isEmpty ? "gbk-download" : filename
        guard let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return false }
        let dir = docs.appendingPathComponent("GBK Downloads", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try data.write(to: dir.appendingPathComponent(safe), options: .atomic)
            return true
        } catch { return false }
    }
}

/// Interleaved 16-bit PCM WAV. Normalize: "peak" -> -1 dBFS peak; "loudness" -> RMS
/// targeted at -14 dBFS, capped so the peak never clips; "off" -> unity gain.
func encodeWavPCM16(left: [Float], right: [Float], sampleRate: Double, normalize: String) -> Data {
    var peak = 0.0, sumSq = 0.0
    let n = left.count
    for i in 0..<n {
        let l = Double(left[i]), r = Double(right[i])
        peak = max(peak, abs(l), abs(r))
        sumSq += l * l + r * r
    }
    var gain = 1.0
    switch normalize {
    case "peak":
        if peak > 0 { gain = 0.891 / peak }
    case "off":
        gain = 1
    default: // loudness
        let rms = n > 0 ? sqrt(sumSq / Double(2 * n)) : 0
        if rms > 0 {
            let target = pow(10.0, -14.0 / 20.0)
            gain = min(target / rms, peak > 0 ? 0.99 / peak : .infinity)
        }
    }
    let sr = Int(sampleRate)
    let frames = n
    var data = Data()
    data.reserveCapacity(44 + frames * 4)
    func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
    func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
    data.append(contentsOf: "RIFF".utf8); u32(UInt32(36 + frames * 4)); data.append(contentsOf: "WAVE".utf8)
    data.append(contentsOf: "fmt ".utf8); u32(16); u16(1); u16(2); u32(UInt32(sr)); u32(UInt32(sr * 4)); u16(4); u16(16)
    data.append(contentsOf: "data".utf8); u32(UInt32(frames * 4))
    for i in 0..<frames {
        for v in [left[i], right[i]] {
            let x = max(-1.0, min(1.0, Double(v) * gain))
            let s = Int16((x * 32767).rounded())
            withUnsafeBytes(of: s.littleEndian) { data.append(contentsOf: $0) }
        }
    }
    return data
}
