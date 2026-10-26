// SPDX-License-Identifier: AGPL-3.0-or-later
import Foundation
import SF2Engine

// Song -> synth render plan, mirroring gbk src/midireader.tsx onExportWav with UI state at its
// defaults (no per-track preset overrides, no mute/solo, track CC 100/64/127), plus
// renderOfflineSequenceToAudioBuffer from src/sf2-renderer.ts.

/// A complete offline/real-time render plan (gbk export: tracks + events + maxVoices + length).
public struct SF2RenderPlan: @unchecked Sendable {
    public var sampleRate: Double
    public var tracks: [SF2TrackState]
    public var events: [SF2SynthEvent]
    public var maxVoices: Int
    public var lengthFrames: Int
    public var song: SMFSong?
    /// Engine rendering rules for this plan (`.gbk`: gbk export, bit-exact; `.spec`: SoundFont 2.04).
    public var fidelity: SF2Fidelity

    public init(sampleRate: Double, tracks: [SF2TrackState], events: [SF2SynthEvent], maxVoices: Int = 64, lengthFrames: Int,
                song: SMFSong? = nil, fidelity: SF2Fidelity = .gbk) {
        self.sampleRate = sampleRate; self.tracks = tracks; self.events = events
        self.maxVoices = maxVoices; self.lengthFrames = lengthFrames; self.song = song; self.fidelity = fidelity
    }
}

public enum SF2SequenceBuilder {
    /// gbk midireader.tsx ORCHESTRA_PAN_RULES (first match wins).
    static let orchestraPanRules: [(NSRegularExpression, Double)] = [
        (#"\bviolin\s*(?:ii|2)\b"#, -0.35), (#"\bviolin\b"#, -0.75), (#"\bviola\b"#, 0.3), (#"\bcello\b"#, 0.65),
        (#"\b(double\s*bass|contrabass|upright\s*bass)\b"#, 0.8), (#"\b(piccolo|flute)\b"#, -0.15), (#"\boboe\b"#, -0.05),
        (#"\bclarinet\b"#, 0.05), (#"\bbassoon\b"#, 0.15), (#"\b(french\s*horn|horn)\b"#, -0.5), (#"\btrumpet\b"#, 0.25),
        (#"\b(trombone|tuba)\b"#, 0.5), (#"\btimpani\b"#, -0.1),
    ].map { (try! NSRegularExpression(pattern: $0.0, options: [.caseInsensitive]), $0.1) }

    public static func resolveOrchestraPan(_ labels: String?...) -> Double? {
        let merged = labels.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " | ").lowercased()
        if merged.isEmpty { return nil }
        let range = NSRange(merged.startIndex..., in: merged)
        for (re, pan) in orchestraPanRules where re.firstMatch(in: merged, range: range) != nil { return pan }
        return nil
    }

    /// JS Math.round for the non-negative frame positions used here.
    @inline(__always) static func jsRound(_ x: Double) -> Int { Int((x + 0.5).rounded(.down)) }

    /// Builds gbk's export plan. `fallbackPreset` = gbk `fallbackPresetIndex` (effective preset, 0).
    /// `programOverride` (not in gbk): play every track with this General MIDI program (bank 0),
    /// ignoring the file's program changes; nil = the file's own instruments (gbk behavior).
    /// `transpose` (not in gbk): semitones added to every note-on / note-off key (clamped to 0...127)
    /// except on the GM percussion channel (10, index 9); 0 = gbk behavior.
    ///
    /// `fidelity: .spec` (not in gbk) renders like a General MIDI / SoundFont 2.04 synth: the file's CC and
    /// pitch-bend messages become engine events, presets are per MIDI channel, and channel 10 (index 9)
    /// plays the bank-128 drum kit of its program (kit 0 by default; `programOverride` leaves it alone).
    public static func plan(song: SMFSong, soundFont: SF2SoundFont, sampleRate: Double, tailSec: Double = 3,
                            fallbackPreset: Int = 0, programOverride: Int? = nil, transpose: Int = 0,
                            fidelity: SF2Fidelity = .gbk) throws -> SF2RenderPlan {
        if fidelity == .spec {
            return try specPlan(song: song, soundFont: soundFont, sampleRate: sampleRate, tailSec: tailSec,
                                fallbackPreset: fallbackPreset, programOverride: programOverride, transpose: transpose)
        }
        var tracks: [SF2TrackState] = []
        var events: [SF2SynthEvent] = []
        let overrideIndex = programOverride.map { soundFont.resolvePresetIndex(program: $0, bank: 0) ?? fallbackPreset }
        for track in song.tracks {
            var defaultPreset: Int?
            for ev in track.playEvents {
                if case let .program(p, b) = ev.kind { defaultPreset = soundFont.resolvePresetIndex(program: p, bank: b); break }
            }
            let presetIndex = overrideIndex ?? defaultPreset ?? fallbackPreset
            let pan = resolveOrchestraPan(track.instrumentName, track.name, soundFont.presetName(presetIndex))
            tracks.append(SF2TrackState(trackIndex: track.index, regions: try soundFont.regionList(forPreset: presetIndex),
                                        cc7Volume: 100, cc10Pan: 64, cc11Expression: 127, pan: pan ?? 0, gain: 1))
            for ev in track.playEvents {
                let frame = max(0, jsRound(ev.sec * sampleRate))
                switch ev.kind {
                case let .noteOn(n, v):
                    events.append(.init(kind: .noteOn, frame: frame, seq: ev.seq, trackIndex: track.index, channel: ev.channel,
                                        note: transposed(n, by: transpose, channel: ev.channel), velocity: v))
                case let .noteOff(n):
                    events.append(.init(kind: .noteOff, frame: frame, seq: ev.seq, trackIndex: track.index, channel: ev.channel,
                                        note: transposed(n, by: transpose, channel: ev.channel)))
                case let .program(p, b):
                    let idx = overrideIndex ?? soundFont.resolvePresetIndex(program: p, bank: b) ?? fallbackPreset
                    events.append(.init(kind: .setPreset, frame: frame, seq: ev.seq, trackIndex: track.index,
                                        regions: try soundFont.regionList(forPreset: idx), presetIndex: idx))
                }
            }
        }
        return SF2RenderPlan(sampleRate: sampleRate, tracks: tracks, events: events,
                             maxVoices: max(96, song.tracks.count * 24),
                             lengthFrames: Int(((song.durationSec + tailSec) * sampleRate).rounded(.up)), song: song)
    }

    static let drumChannel = 9
    /// Track gain of spec plans (+6 dB). gbk ignores preset-zone key/velocity ranges and layers every split
    /// of multi-instrument presets (GeneralUser GS piano: up to 6 voices per key); the spec build plays one,
    /// so it is ~8-12 dB quieter on the parity songs. This brings it back near gbk's level without clipping.
    public static let specMakeupGain = 2.0

    /// SoundFont 2.04 / GM plan: per-channel presets (drums on channel 10 from bank 128), CC and pitch-bend events.
    static func specPlan(song: SMFSong, soundFont sf: SF2SoundFont, sampleRate: Double, tailSec: Double,
                         fallbackPreset: Int, programOverride: Int?, transpose: Int) throws -> SF2RenderPlan {
        var tracks: [SF2TrackState] = []
        var events: [SF2SynthEvent] = []
        func preset(program: Int, bank: Int, channel: Int) -> Int {
            if channel == drumChannel {
                return sf.resolvePresetIndex(program: program, bank: 128) ?? sf.resolvePresetIndex(program: 0, bank: 128) ?? fallbackPreset
            }
            if let o = programOverride { return sf.resolvePresetIndex(program: o, bank: 0) ?? fallbackPreset }
            return sf.resolvePresetIndex(program: program, bank: bank) ?? fallbackPreset
        }
        for track in song.tracks {
            // Channel presets at frame 0: each channel's first program in this track (GM: program 0).
            var channels: [Int] = []
            var first: [Int: (Int, Int)] = [:]
            for ev in track.playEvents {
                if !channels.contains(ev.channel) { channels.append(ev.channel) }
                if case let .program(p, b) = ev.kind, first[ev.channel] == nil { first[ev.channel] = (p, b) }
            }
            for c in track.controlEvents where !channels.contains(c.channel) { channels.append(c.channel) }
            let mainChannel = track.playEvents.first { if case .noteOn = $0.kind { return true }; return false }?.channel ?? channels.first ?? 0
            let mainIndex = preset(program: first[mainChannel]?.0 ?? 0, bank: first[mainChannel]?.1 ?? 0, channel: mainChannel)
            let pan = resolveOrchestraPan(track.instrumentName, track.name, sf.presetName(mainIndex))
            tracks.append(SF2TrackState(trackIndex: track.index, regions: try sf.regionList(forPreset: mainIndex, fidelity: .spec),
                                        cc7Volume: 100, cc10Pan: 64, cc11Expression: 127, pan: pan ?? 0, gain: specMakeupGain))
            for ch in channels {
                let idx = preset(program: first[ch]?.0 ?? 0, bank: first[ch]?.1 ?? 0, channel: ch)
                events.append(.init(kind: .setPreset, frame: 0, seq: -1, trackIndex: track.index, channel: ch,
                                    regions: try sf.regionList(forPreset: idx, fidelity: .spec), presetIndex: idx))
            }
            for ev in track.playEvents {
                let frame = max(0, jsRound(ev.sec * sampleRate))
                switch ev.kind {
                case let .noteOn(n, v):
                    events.append(.init(kind: .noteOn, frame: frame, seq: ev.seq, trackIndex: track.index, channel: ev.channel,
                                        note: transposed(n, by: transpose, channel: ev.channel), velocity: v))
                case let .noteOff(n):
                    events.append(.init(kind: .noteOff, frame: frame, seq: ev.seq, trackIndex: track.index, channel: ev.channel,
                                        note: transposed(n, by: transpose, channel: ev.channel)))
                case let .program(p, b):
                    let idx = preset(program: p, bank: b, channel: ev.channel)
                    events.append(.init(kind: .setPreset, frame: frame, seq: ev.seq, trackIndex: track.index, channel: ev.channel,
                                        regions: try sf.regionList(forPreset: idx, fidelity: .spec), presetIndex: idx))
                }
            }
            for c in track.controlEvents {
                let frame = max(0, jsRound(c.sec * sampleRate))
                switch c.kind {
                case let .cc(controller, value):
                    events.append(.controlChange(controller, value: value, frame: frame, seq: c.seq, trackIndex: track.index, channel: c.channel))
                case let .pitchBend(value):
                    events.append(.pitchBend(value + 8192, frame: frame, seq: c.seq, trackIndex: track.index, channel: c.channel))
                }
            }
        }
        return SF2RenderPlan(sampleRate: sampleRate, tracks: tracks, events: events,
                             maxVoices: max(96, song.tracks.count * 24),
                             lengthFrames: Int(((song.durationSec + tailSec) * sampleRate).rounded(.up)), song: song, fidelity: .spec)
    }

    /// `note + semitones` clamped to the MIDI range; channel index 9 (GM drums) is never transposed.
    public static func transposed(_ note: Int, by semitones: Int, channel: Int?) -> Int {
        if semitones == 0 || channel == 9 { return note }
        return max(0, min(127, note + semitones))
    }

    /// renderOfflineSequenceToAudioBuffer's event order (SF2Engine `SF2EventOrder`).
    public static func sortedEvents(_ events: [SF2SynthEvent]) -> [SF2SynthEvent] { SF2EventOrder.sorted(events) }
}

extension SF2OfflineRenderer {
    public static func render(_ plan: SF2RenderPlan) -> SF2StereoBuffer {
        renderOfflineSequence(sampleRate: plan.sampleRate, length: plan.lengthFrames, tracks: plan.tracks, events: plan.events,
                              maxVoices: plan.maxVoices, fidelity: plan.fidelity)
    }

    /// Convenience: MIDI bytes -> gbk export render (length = duration + tail).
    public static func render(midi: Data, soundFont: SF2SoundFont, sampleRate: Double = 44100, tailSec: Double = 3,
                              fidelity: SF2Fidelity = .gbk) throws -> SF2StereoBuffer {
        render(try SF2SequenceBuilder.plan(song: try SMFSong(data: midi), soundFont: soundFont, sampleRate: sampleRate, tailSec: tailSec,
                                           fidelity: fidelity))
    }
}
