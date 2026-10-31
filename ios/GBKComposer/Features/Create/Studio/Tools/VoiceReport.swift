import Foundation

// Port of voiceReport + helpers from src/workstation/sound.ts and src/sf2/voice-overrides.ts.
// Region data comes from the host (WorkstationHost.trackRegionsJSON) as JSON in the TS
// SF2Region shape: { presetName, presetIndex, regions: [{ keyRange, velRange,
// sample: { sampleRate, originalKey, overridingRootKey }, <scalar gen fields>, volEnv, modEnv,
// modulators: [{ dest, src, amount }] }] } — the Phase 5 SF2 driver vends exactly this.

struct VoiceRegion {
    var keyRange: (Int, Int) = (0, 127)
    var velRange: (Int, Int) = (0, 127)
    var sampleRate: Int = 44100
    var originalKey: Int = 60
    var overridingRootKey: Int? = nil
    var coarseTune: Double = 0, fineTune: Double = 0, scaleTuning: Double = 100
    var initialAttenuationCb: Double = 0, pan: Double = 0
    var initialFilterFcCents: Double = 13500, initialFilterQCb: Double = 0
    var modEnvToFilterFcCents: Double = 0, modLfoToFilterFcCents: Double = 0
    var modLfoDelayTc: Double = -12000, modLfoFreqCents: Double = 0, modLfoToPitchCents: Double = 0
    var vibLfoDelayTc: Double = -12000, vibLfoFreqCents: Double = 0, vibLfoToPitchCents: Double = 0
    var modEnvToPitchCents: Double = 0, modLfoToVolumeCb: Double = 0
    var chorusSend: Double = 0, reverbSend: Double = 0
    var keynumToModEnvHold: Double = 0, keynumToModEnvDecay: Double = 0
    var keynumToVolEnvHold: Double = 0, keynumToVolEnvDecay: Double = 0
    var volEnv = (delayTc: -12000.0, attackTc: -12000.0, holdTc: -12000.0, decayTc: -12000.0, sustainCb: 0.0, releaseTc: -12000.0)
    var modEnv = (delayTc: -12000.0, attackTc: -12000.0, holdTc: -12000.0, decayTc: -12000.0, sustain: 1.0, releaseTc: -12000.0)
    var modulators: [(dest: Int, src: Int, amount: Double)] = []

    init(json: JSONValue) {
        if let kr = json["keyRange"]?.arrayValue, kr.count == 2 { keyRange = (kr[0].intValue ?? 0, kr[1].intValue ?? 127) }
        if let vr = json["velRange"]?.arrayValue, vr.count == 2 { velRange = (vr[0].intValue ?? 0, vr[1].intValue ?? 127) }
        if let s = json["sample"] {
            sampleRate = s["sampleRate"]?.intValue ?? 44100
            originalKey = s["originalKey"]?.intValue ?? 60
            overridingRootKey = s["overridingRootKey"]?.intValue
        }
        func d(_ k: String) -> Double? { json[k]?.doubleValue }
        coarseTune = d("coarseTune") ?? coarseTune; fineTune = d("fineTune") ?? fineTune; scaleTuning = d("scaleTuning") ?? scaleTuning
        initialAttenuationCb = d("initialAttenuationCb") ?? initialAttenuationCb; pan = d("pan") ?? pan
        initialFilterFcCents = d("initialFilterFcCents") ?? initialFilterFcCents; initialFilterQCb = d("initialFilterQCb") ?? initialFilterQCb
        modEnvToFilterFcCents = d("modEnvToFilterFcCents") ?? modEnvToFilterFcCents; modLfoToFilterFcCents = d("modLfoToFilterFcCents") ?? modLfoToFilterFcCents
        modLfoDelayTc = d("modLfoDelayTc") ?? modLfoDelayTc; modLfoFreqCents = d("modLfoFreqCents") ?? modLfoFreqCents; modLfoToPitchCents = d("modLfoToPitchCents") ?? modLfoToPitchCents
        vibLfoDelayTc = d("vibLfoDelayTc") ?? vibLfoDelayTc; vibLfoFreqCents = d("vibLfoFreqCents") ?? vibLfoFreqCents; vibLfoToPitchCents = d("vibLfoToPitchCents") ?? vibLfoToPitchCents
        modEnvToPitchCents = d("modEnvToPitchCents") ?? modEnvToPitchCents; modLfoToVolumeCb = d("modLfoToVolumeCb") ?? modLfoToVolumeCb
        chorusSend = d("chorusSend") ?? chorusSend; reverbSend = d("reverbSend") ?? reverbSend
        keynumToModEnvHold = d("keynumToModEnvHold") ?? keynumToModEnvHold; keynumToModEnvDecay = d("keynumToModEnvDecay") ?? keynumToModEnvDecay
        keynumToVolEnvHold = d("keynumToVolEnvHold") ?? keynumToVolEnvHold; keynumToVolEnvDecay = d("keynumToVolEnvDecay") ?? keynumToVolEnvDecay
        if let ve = json["volEnv"] {
            volEnv = (ve["delayTc"]?.doubleValue ?? volEnv.delayTc, ve["attackTc"]?.doubleValue ?? volEnv.attackTc,
                      ve["holdTc"]?.doubleValue ?? volEnv.holdTc, ve["decayTc"]?.doubleValue ?? volEnv.decayTc,
                      ve["sustainCb"]?.doubleValue ?? volEnv.sustainCb, ve["releaseTc"]?.doubleValue ?? volEnv.releaseTc)
        }
        if let me = json["modEnv"] {
            modEnv = (me["delayTc"]?.doubleValue ?? modEnv.delayTc, me["attackTc"]?.doubleValue ?? modEnv.attackTc,
                      me["holdTc"]?.doubleValue ?? modEnv.holdTc, me["decayTc"]?.doubleValue ?? modEnv.decayTc,
                      me["sustain"]?.doubleValue ?? modEnv.sustain, me["releaseTc"]?.doubleValue ?? modEnv.releaseTc)
        }
        modulators = (json["modulators"]?.arrayValue ?? []).map {
            (dest: $0["dest"]?.intValue ?? 0, src: $0["src"]?.intValue ?? 0, amount: $0["amount"]?.doubleValue ?? 0)
        }
    }
}

/// Port of regionGenValue (voice-overrides.ts).
func regionGenValue(_ r: VoiceRegion, _ gen: Int) -> Double {
    switch gen {
    case 5: return r.modLfoToPitchCents
    case 6: return r.vibLfoToPitchCents
    case 7: return r.modEnvToPitchCents
    case 8: return r.initialFilterFcCents
    case 9: return r.initialFilterQCb
    case 10: return r.modLfoToFilterFcCents
    case 11: return r.modEnvToFilterFcCents
    case 13: return r.modLfoToVolumeCb
    case 15: return r.chorusSend
    case 16: return r.reverbSend
    case 17: return r.pan
    case 21: return r.modLfoDelayTc
    case 22: return r.modLfoFreqCents
    case 23: return r.vibLfoDelayTc
    case 24: return r.vibLfoFreqCents
    case 25: return r.modEnv.delayTc
    case 26: return r.modEnv.attackTc
    case 27: return r.modEnv.holdTc
    case 28: return r.modEnv.decayTc
    case 29: return ((1 - r.modEnv.sustain) * 1000).rounded()
    case 30: return r.modEnv.releaseTc
    case 31: return r.keynumToModEnvHold
    case 32: return r.keynumToModEnvDecay
    case 33: return r.volEnv.delayTc
    case 34: return r.volEnv.attackTc
    case 35: return r.volEnv.holdTc
    case 36: return r.volEnv.decayTc
    case 37: return r.volEnv.sustainCb
    case 38: return r.volEnv.releaseTc
    case 39: return r.keynumToVolEnvHold
    case 40: return r.keynumToVolEnvDecay
    case 48: return r.initialAttenuationCb
    case 51: return r.coarseTune
    case 52: return r.fineTune
    case 56: return r.scaleTuning
    default: return 0
    }
}

/// Port of computeOverrideDeltas: per-gen override deltas for a zone at `key`.
func computeOverrideDeltas(_ list: [VoiceOverride], _ r: VoiceRegion, _ key: Int) -> [Double] {
    var out = [Double](repeating: 0, count: 61)
    for o in list {
        if let lo = o.keyLo, key < lo { continue }
        if let hi = o.keyHi, key > hi { continue }
        if o.mode == "set" { out[o.gen] = clampGenValue(o.gen, o.value) - regionGenValue(r, o.gen) }
        else { out[o.gen] += o.value }
    }
    return out
}

/// voice-overrides.ts round4 (different from VoiceModel.round4 for |x| >= 100).
func round4VO(_ x: Double) -> Double { abs(x) >= 100 ? (x * 10).rounded() / 10 : (x * 10000).rounded() / 10000 }

/// Port of effectiveVoice: zone + overrides per VOICE_PARAMS entry, in human units.
func effectiveVoiceJSON(_ r: VoiceRegion, _ list: [VoiceOverride], _ key: Int) -> JSONValue {
    let d = computeOverrideDeltas(list, r, key)
    var pairs: [(String, JSONValue)] = []
    for p in voiceParams {
        let zone = regionGenValue(r, p.gen)
        let native = clampGenValue(p.gen, zone + d[p.gen])
        pairs.append((p.name, .object([
            ("gen", .int(Int64(p.gen))), ("native", .number(native)), ("zone", .number(zone)),
            ("value", .number(round4VO(nativeToHuman(gen: p.gen, native)))), ("unit", .string(p.unit)),
            ("overridden", .bool(d[p.gen] != 0)),
        ])))
    }
    return .object(pairs)
}

/// Controller value in effect at `tick` on the track, else the MIDI power-on default.
func ccAt(_ p: Project, _ trackId: String, _ controller: Int, _ tick: Int) -> Int {
    var v = controller == 7 ? 100 : controller == 10 ? 64 : controller == 11 ? 127 : 0
    for c in p.ccs where c.trackId == trackId && c.controller == controller && c.tick <= tick { v = c.value }
    return v
}

private func sendModAmount(_ r: VoiceRegion, dest: Int, cc: Int) -> Double {
    let src = dest == 16 ? 91 : 93
    let m = r.modulators.first { $0.dest == dest && ($0.src & 0x80) != 0 && ($0.src & 0x7f) == src }
    return (m?.amount ?? 200) * (Double(cc) / 128)
}

private func fixed2(_ x: Double) -> Double { (x * 100).rounded() / 100 }

/// Port of voiceReport (sound.ts). `host` is the trackRegionsJSON payload (or nil).
func voiceReportJSON(_ p: Project, _ trackId: String, _ host: JSONValue?, key: Int = 60, velocity: Int = 100, tick: Int = 0) -> JSONValue {
    let overrides = p.sound?.tracks[trackId] ?? []
    let effects = normalizeEffects(p.sound?.effects)
    let cc91 = ccAt(p, trackId, 91, tick), cc93 = ccAt(p, trackId, 93, tick)
    let regions = (host?["regions"]?.arrayValue ?? []).map(VoiceRegion.init)
    let zones = regions.filter { key >= $0.keyRange.0 && key <= $0.keyRange.1 && velocity >= $0.velRange.0 && velocity <= $0.velRange.1 }
    func send(_ r: VoiceRegion, _ gen: Int, _ cc: Int) -> JSONValue {
        let zone = regionGenValue(r, gen), mod = sendModAmount(r, dest: gen, cc: cc)
        let d = computeOverrideDeltas(overrides, r, key)
        return .object([
            ("zonePercent", .number(zone / 10)),
            ("ccModulatorPercent", .number(fixed2(mod / 10))),
            ("overridePercent", .number(d[gen] / 10)),
            ("effectivePercent", .number(fixed2(clampGenValue(gen, zone + mod + d[gen]) / 10))),
        ])
    }
    return .object([
        ("trackId", .string(trackId)), ("key", .int(Int64(key))), ("velocity", .int(Int64(velocity))),
        ("preset", host.map { .object([("index", $0["presetIndex"] ?? .null), ("name", $0["presetName"] ?? .null)]) } ?? .null),
        ("overrides", .array(overrides.map { $0.json })),
        ("effects", effects.json),
        ("controllers", .object([("cc91ReverbSend", .int(Int64(cc91))), ("cc93ChorusSend", .int(Int64(cc93)))])),
        ("zones", .array(zones.map { r in
            .object([
                ("keyRange", .array([.int(Int64(r.keyRange.0)), .int(Int64(r.keyRange.1))])),
                ("velRange", .array([.int(Int64(r.velRange.0)), .int(Int64(r.velRange.1))])),
                ("sample", .object([("rate", .int(Int64(r.sampleRate))), ("rootKey", .int(Int64(r.overridingRootKey ?? r.originalKey)))])),
                ("generators", effectiveVoiceJSON(r, overrides, key)),
                ("effectiveSends", .object([("reverb", send(r, 16, cc91)), ("chorus", send(r, 15, cc93))])),
            ])
        })),
        ("notes", .array([
            .string("generators = zone (preset+instrument summed per SF2 9.4) + overrides, clamped to SF2 ranges, before modulators (velocity, CCs)."),
            .string("effectiveSends include the SF2 2.01 default modulators CC91->reverb / CC93->chorus (200 = 20% at CC 127) unless the preset defines its own."),
            .string("Envelope times are seconds (decay/release = time for a 100 dB fall), sustain/attenuation in dB of attenuation, cutoff / LFO rates in Hz."),
        ])),
    ])
}
