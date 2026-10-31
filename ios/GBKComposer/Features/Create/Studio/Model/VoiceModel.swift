import Foundation

/// Ports of src/sf2/geninfo.ts, src/sf2/voice-overrides.ts and src/sf2/sound.ts (the value math).
/// Generator ids: SoundFont 2.01 section 8.1.3.

enum GenKind: String, Sendable { case index, range, substitution, sample, value }

struct GenInfo: Sendable {
    var id: Int; var kind: GenKind; var min: Double; var max: Double; var defaultValue: Double
    var instrumentOnly: Bool; var realtime: Bool
}

let genTable: [Int: GenInfo] = {
    var t: [Int: GenInfo] = [:]
    func v(_ id: Int, _ lo: Double, _ hi: Double, _ def: Double, rt: Bool = true) {
        t[id] = GenInfo(id: id, kind: .value, min: lo, max: hi, defaultValue: def, instrumentOnly: false, realtime: rt)
    }
    func s(_ id: Int, _ lo: Double, _ hi: Double, _ def: Double, rt: Bool = true) {
        t[id] = GenInfo(id: id, kind: .sample, min: lo, max: hi, defaultValue: def, instrumentOnly: true, realtime: rt)
    }
    let big = 32767.0 * 32768.0
    s(0, 0, big, 0); s(1, -big, 0, 0); s(2, -big, big, 0); s(3, -big, big, 0); s(4, 0, 32767, 0)
    v(5, -12000, 12000, 0); v(6, -12000, 12000, 0); v(7, -12000, 12000, 0)
    v(8, 1500, 13500, 13500); v(9, 0, 960, 0); v(10, -12000, 12000, 0); v(11, -12000, 12000, 0)
    s(12, -32768, 0, 0); v(13, -960, 960, 0)
    v(15, 0, 1000, 0); v(16, 0, 1000, 0); v(17, -500, 500, 0)
    v(21, -12000, 5000, -12000); v(22, -16000, 4500, 0); v(23, -12000, 5000, -12000); v(24, -16000, 4500, 0)
    v(25, -12000, 5000, -12000); v(26, -12000, 8000, -12000); v(27, -12000, 5000, -12000); v(28, -12000, 8000, -12000)
    v(29, 0, 1000, 0); v(30, -12000, 8000, -12000); v(31, -1200, 1200, 0); v(32, -1200, 1200, 0)
    v(33, -12000, 5000, -12000); v(34, -12000, 8000, -12000); v(35, -12000, 5000, -12000); v(36, -12000, 8000, -12000)
    v(37, 0, 1440, 0); v(38, -12000, 8000, -12000); v(39, -1200, 1200, 0); v(40, -1200, 1200, 0)
    t[41] = GenInfo(id: 41, kind: .index, min: 0, max: 65535, defaultValue: 0, instrumentOnly: false, realtime: false)
    t[43] = GenInfo(id: 43, kind: .range, min: 0, max: 0x7f7f, defaultValue: 0x7f00, instrumentOnly: false, realtime: false)
    t[44] = GenInfo(id: 44, kind: .range, min: 0, max: 0x7f7f, defaultValue: 0x7f00, instrumentOnly: false, realtime: false)
    s(45, -32768, 32767, 0)
    t[46] = GenInfo(id: 46, kind: .substitution, min: 0, max: 127, defaultValue: -1, instrumentOnly: true, realtime: false)
    t[47] = GenInfo(id: 47, kind: .substitution, min: 0, max: 127, defaultValue: -1, instrumentOnly: true, realtime: false)
    v(48, 0, 1440, 0)
    s(50, -32768, 32767, 0)
    v(51, -120, 120, 0); v(52, -99, 99, 0)
    t[53] = GenInfo(id: 53, kind: .index, min: 0, max: 65535, defaultValue: 0, instrumentOnly: true, realtime: false)
    s(54, 0, 3, 0, rt: false)
    t[56] = GenInfo(id: 56, kind: .value, min: 0, max: 1200, defaultValue: 100, instrumentOnly: false, realtime: false)
    s(57, 0, 127, 0, rt: false)
    s(58, 0, 127, -1, rt: false)
    return t
}()

func genInfo(_ id: Int) -> GenInfo? { (id >= 0 && id < 61) ? genTable[id] : nil }
func genDefaultValue(_ id: Int) -> Double { genInfo(id)?.defaultValue ?? 0 }
/// The legal absolute range for a VALUE generator (nil for addressed/sample/index kinds).
func valueRange(_ gen: Int) -> (min: Double, max: Double)? {
    guard let i = genInfo(gen), i.kind == .value else { return nil }
    return (i.min, i.max)
}
func clampGenValue(_ gen: Int, _ v: Double) -> Double {
    guard let r = valueRange(gen) else { return v }
    return min(r.max, max(r.min, v))
}

// MARK: - Voice overrides

struct VoiceOverride: Equatable, Sendable {
    var gen: Int
    var mode: String // "add" | "set"
    var value: Double
    var keyLo: Int?
    var keyHi: Int?

    var json: JSONValue {
        var o: [(String, JSONValue)] = [("gen", .int(Int64(gen))), ("mode", .string(mode)), ("value", .number(value))]
        if let keyLo { o.append(("keyLo", .int(Int64(keyLo)))) }
        if let keyHi { o.append(("keyHi", .int(Int64(keyHi)))) }
        return .object(o)
    }
    init(gen: Int, mode: String, value: Double, keyLo: Int? = nil, keyHi: Int? = nil) {
        self.gen = gen; self.mode = mode; self.value = value; self.keyLo = keyLo; self.keyHi = keyHi
    }
    init?(json: JSONValue) {
        guard let g = json["gen"]?.intValue, let m = json["mode"]?.stringValue, let v = json["value"]?.doubleValue else { return nil }
        self.init(gen: g, mode: m, value: v, keyLo: json["keyLo"]?.intValue, keyHi: json["keyHi"]?.intValue)
    }
}

struct VoiceParamInfo: Sendable {
    var gen: Int; var name: String; var group: String; var unit: String; var native: String; var description: String; var realtime: Bool
}

let voiceParams: [VoiceParamInfo] = [
    .init(gen: 33, name: "volEnvDelay", group: "volEnv", unit: "seconds", native: "timecents", description: "Volume envelope delay", realtime: false),
    .init(gen: 34, name: "volEnvAttack", group: "volEnv", unit: "seconds", native: "timecents", description: "Volume envelope attack (linear rise)", realtime: false),
    .init(gen: 35, name: "volEnvHold", group: "volEnv", unit: "seconds", native: "timecents", description: "Volume envelope hold", realtime: false),
    .init(gen: 36, name: "volEnvDecay", group: "volEnv", unit: "seconds", native: "timecents", description: "Volume envelope decay (time for 100 dB)", realtime: false),
    .init(gen: 37, name: "volEnvSustain", group: "volEnv", unit: "dB", native: "centibels", description: "Volume envelope sustain attenuation (0 dB = full level)", realtime: false),
    .init(gen: 38, name: "volEnvRelease", group: "volEnv", unit: "seconds", native: "timecents", description: "Volume envelope release (time for 100 dB)", realtime: false),
    .init(gen: 39, name: "keynumToVolEnvHold", group: "volEnv", unit: "tc/key", native: "timecents per key", description: "Hold time scaling per key from 60", realtime: false),
    .init(gen: 40, name: "keynumToVolEnvDecay", group: "volEnv", unit: "tc/key", native: "timecents per key", description: "Decay time scaling per key from 60", realtime: false),
    .init(gen: 25, name: "modEnvDelay", group: "modEnv", unit: "seconds", native: "timecents", description: "Modulation envelope delay", realtime: false),
    .init(gen: 26, name: "modEnvAttack", group: "modEnv", unit: "seconds", native: "timecents", description: "Modulation envelope attack", realtime: false),
    .init(gen: 27, name: "modEnvHold", group: "modEnv", unit: "seconds", native: "timecents", description: "Modulation envelope hold", realtime: false),
    .init(gen: 28, name: "modEnvDecay", group: "modEnv", unit: "seconds", native: "timecents", description: "Modulation envelope decay", realtime: false),
    .init(gen: 29, name: "modEnvSustain", group: "modEnv", unit: "percent", native: "0.1 % below full", description: "Modulation envelope sustain decrease (0 % = full)", realtime: false),
    .init(gen: 30, name: "modEnvRelease", group: "modEnv", unit: "seconds", native: "timecents", description: "Modulation envelope release", realtime: false),
    .init(gen: 7, name: "modEnvToPitch", group: "modEnv", unit: "cents", native: "cents", description: "Mod envelope -> pitch depth", realtime: true),
    .init(gen: 11, name: "modEnvToFilterFc", group: "modEnv", unit: "cents", native: "cents", description: "Mod envelope -> filter cutoff depth", realtime: true),
    .init(gen: 8, name: "filterCutoff", group: "filter", unit: "Hz", native: "absolute cents", description: "Low-pass cutoff (13500 cents ~ 20 kHz = open)", realtime: true),
    .init(gen: 9, name: "filterQ", group: "filter", unit: "dB", native: "centibels", description: "Low-pass resonance above DC", realtime: true),
    .init(gen: 21, name: "modLfoDelay", group: "lfo", unit: "seconds", native: "timecents", description: "Modulation LFO delay", realtime: false),
    .init(gen: 22, name: "modLfoFreq", group: "lfo", unit: "Hz", native: "absolute cents", description: "Modulation LFO frequency", realtime: false),
    .init(gen: 5, name: "modLfoToPitch", group: "lfo", unit: "cents", native: "cents", description: "Mod LFO -> pitch depth", realtime: true),
    .init(gen: 10, name: "modLfoToFilterFc", group: "lfo", unit: "cents", native: "cents", description: "Mod LFO -> filter cutoff depth", realtime: true),
    .init(gen: 13, name: "modLfoToVolume", group: "lfo", unit: "dB", native: "centibels", description: "Mod LFO -> volume (tremolo) depth", realtime: true),
    .init(gen: 23, name: "vibLfoDelay", group: "vibrato", unit: "seconds", native: "timecents", description: "Vibrato LFO delay", realtime: false),
    .init(gen: 24, name: "vibLfoFreq", group: "vibrato", unit: "Hz", native: "absolute cents", description: "Vibrato LFO frequency", realtime: false),
    .init(gen: 6, name: "vibLfoToPitch", group: "vibrato", unit: "cents", native: "cents", description: "Vibrato depth", realtime: true),
    .init(gen: 51, name: "coarseTune", group: "tuning", unit: "semitones", native: "semitones", description: "Coarse tuning", realtime: true),
    .init(gen: 52, name: "fineTune", group: "tuning", unit: "cents", native: "cents", description: "Fine tuning", realtime: true),
    .init(gen: 56, name: "scaleTuning", group: "tuning", unit: "cents/key", native: "cents per key", description: "Key tracking (100 = equal temperament, 0 = same pitch on every key)", realtime: false),
    .init(gen: 17, name: "pan", group: "mix", unit: "percent", native: "0.1 % (-500 left ... 500 right)", description: "Zone pan (-50 % left ... +50 % right)", realtime: true),
    .init(gen: 48, name: "attenuation", group: "mix", unit: "dB", native: "centibels", description: "Initial attenuation (positive = quieter)", realtime: true),
    .init(gen: 15, name: "chorusSend", group: "effects", unit: "percent", native: "0.1 %", description: "Chorus effects send", realtime: true),
    .init(gen: 16, name: "reverbSend", group: "effects", unit: "percent", native: "0.1 %", description: "Reverb effects send", realtime: true),
]
let voiceParamByName: [String: VoiceParamInfo] = Dictionary(uniqueKeysWithValues: voiceParams.map { ($0.name, $0) })
let voiceParamByGen: [Int: VoiceParamInfo] = Dictionary(uniqueKeysWithValues: voiceParams.map { ($0.gen, $0) })

func nativeToHuman(gen: Int, _ v: Double) -> Double {
    guard let info = voiceParamByGen[gen] else { return v }
    switch info.unit {
    case "seconds": return pow(2, v / 1200)
    case "Hz": return 8.176 * pow(2, v / 1200)
    case "dB", "percent": return v / 10
    default: return v
    }
}
func humanToNative(gen: Int, _ h: Double) -> Double {
    guard let info = voiceParamByGen[gen] else { return h }
    switch info.unit {
    case "seconds": return 1200 * log2(h)
    case "Hz": return 1200 * log2(h / 8.176)
    case "dB", "percent": return h * 10
    default: return h
    }
}
/// Human-units range for a param (converted), used to validate `set` edits in human space.
func humanRange(gen: Int) -> (min: Double, max: Double)? {
    guard let r = valueRange(gen) else { return nil }
    return (nativeToHuman(gen: gen, r.min), nativeToHuman(gen: gen, r.max))
}
func round4(_ v: Double) -> Double { (v * 10000).rounded() / 10000 }

/// Returns an error string or nil (mirrors validateOverride in voice-overrides.ts).
func validateOverride(_ o: VoiceOverride) -> String? {
    let info = genInfo(o.gen)
    if info == nil { return "unknown generator \(o.gen)" }
    if info!.kind != .value && o.gen != 56 { return "generator \(o.gen) is a \(info!.kind.rawValue) generator and cannot be overridden" }
    if o.gen == 43 || o.gen == 44 { return "key/velocity ranges are zone structure, not overrides" }
    if !o.value.isFinite { return "override value must be finite" }
    if o.mode == "set", let r = valueRange(o.gen), o.value < r.min || o.value > r.max {
        return "set value \(jsNum(o.value)) for gen \(o.gen) outside [\(jsNum(r.min)), \(jsNum(r.max))]"
    }
    if let lo = o.keyLo, lo < 0 || lo > 127 { return "keyLo out of range" }
    if let hi = o.keyHi, hi < 0 || hi > 127 { return "keyHi out of range" }
    if let lo = o.keyLo, let hi = o.keyHi, lo > hi { return "keyLo > keyHi" }
    return nil
}

/// JS-style number formatting for error messages (integers without a decimal point).
func jsNum(_ d: Double) -> String { JSONValue.formatDouble(d) }

// MARK: - NRPN export (sound.ts overridesToNrpn)

func nrpnStep(_ gen: Int) -> Double {
    let info = genInfo(gen)
    var span = (info?.max ?? 0) - (info?.min ?? 0)
    var step = 1.0
    while span / step > 8192 { span /= 2; step *= 2 }
    return step
}

/// Overrides a generic SF2 host can apply via NRPN (CC 99 = 120): adds only, gen-wide, gen != 56.
func overridesToNrpn(_ ovs: [VoiceOverride]) -> [(controller: Int, value: Int)] {
    var out: [(Int, Int)] = []
    for o in ovs {
        if o.mode != "add" || o.keyLo != nil || o.keyHi != nil || o.gen == 56 { continue }
        let g = o.gen
        let amount = o.value
        if amount == 0 { continue }
        let step = nrpnStep(g)
        let data = min(16383, max(0, Int((amount / step).rounded()) + 8192))
        if g >= 100 { out.append((38, (data >> 7) & 0x7f)) }
        out.append((99, 120))
        out.append((98, g & 0x7f))
        out.append((6, (data >> 7) & 0x7f))
        out.append((38, data & 0x7f))
    }
    return out.map { (controller: $0.0, value: $0.1) }
}

// MARK: - Effects (sound.ts)

struct EffectsParams: Equatable, Sendable {
    var enabled: Bool?; var roomSize: Double?; var damping: Double?; var reverbLevel: Double?
    var chorusLevel: Double?; var chorusDepthMs: Double?; var chorusRateHz: Double?; var chorusDelayMs: Double?

    var json: JSONValue {
        var o: [(String, JSONValue)] = []
        if let enabled { o.append(("enabled", .bool(enabled))) }
        if let roomSize { o.append(("roomSize", .number(roomSize))) }
        if let damping { o.append(("damping", .number(damping))) }
        if let reverbLevel { o.append(("reverbLevel", .number(reverbLevel))) }
        if let chorusLevel { o.append(("chorusLevel", .number(chorusLevel))) }
        if let chorusDepthMs { o.append(("chorusDepthMs", .number(chorusDepthMs))) }
        if let chorusRateHz { o.append(("chorusRateHz", .number(chorusRateHz))) }
        if let chorusDelayMs { o.append(("chorusDelayMs", .number(chorusDelayMs))) }
        return .object(o)
    }
    init() {}
    init?(json: JSONValue) {
        self.init()
        enabled = json["enabled"]?.boolValue
        roomSize = json["roomSize"]?.doubleValue
        damping = json["damping"]?.doubleValue
        reverbLevel = json["reverbLevel"]?.doubleValue
        chorusLevel = json["chorusLevel"]?.doubleValue
        chorusDepthMs = json["chorusDepthMs"]?.doubleValue
        chorusRateHz = json["chorusRateHz"]?.doubleValue
        chorusDelayMs = json["chorusDelayMs"]?.doubleValue
    }
    init(full: (enabled: Bool, roomSize: Double, damping: Double, reverbLevel: Double, chorusLevel: Double, chorusDepthMs: Double, chorusRateHz: Double, chorusDelayMs: Double)) {
        self.init(); enabled = full.enabled; roomSize = full.roomSize; damping = full.damping; reverbLevel = full.reverbLevel
        chorusLevel = full.chorusLevel; chorusDepthMs = full.chorusDepthMs; chorusRateHz = full.chorusRateHz; chorusDelayMs = full.chorusDelayMs
    }
}

let effectsRanges: [String: (min: Double, max: Double)] = [
    "roomSize": (0, 1), "damping": (0, 1), "reverbLevel": (0, 1), "chorusLevel": (0, 1),
    "chorusDepthMs": (0, 10), "chorusRateHz": (0.05, 5), "chorusDelayMs": (1, 30),
]
let effectsDefaults = EffectsParams(full: (enabled: true, roomSize: 0.5, damping: 0.5, reverbLevel: 0.5, chorusLevel: 0.7, chorusDepthMs: 4, chorusRateHz: 0.6, chorusDelayMs: 12))

/// Full, clamped, concrete effect parameters for the engine.
func normalizeEffects(_ p: EffectsParams?) -> EffectsParams {
    let src = p ?? EffectsParams()
    func pick(_ v: Double?, _ key: String, _ def: Double) -> Double {
        let r = effectsRanges[key]!
        return min(r.max, max(r.min, v ?? def))
    }
    return EffectsParams(full: (
        enabled: src.enabled ?? true,
        roomSize: pick(src.roomSize, "roomSize", effectsDefaults.roomSize!),
        damping: pick(src.damping, "damping", effectsDefaults.damping!),
        reverbLevel: pick(src.reverbLevel, "reverbLevel", effectsDefaults.reverbLevel!),
        chorusLevel: pick(src.chorusLevel, "chorusLevel", effectsDefaults.chorusLevel!),
        chorusDepthMs: pick(src.chorusDepthMs, "chorusDepthMs", effectsDefaults.chorusDepthMs!),
        chorusRateHz: pick(src.chorusRateHz, "chorusRateHz", effectsDefaults.chorusRateHz!),
        chorusDelayMs: pick(src.chorusDelayMs, "chorusDelayMs", effectsDefaults.chorusDelayMs!)))
}

/// User/agent sound edits in human units (src/sf2/sound.ts).
enum HumanEdit {
    case set(Double)
    case add(Double)
    case scale(Double)
}
func humanEditToOverride(param: String, edit: HumanEdit) -> Result<VoiceOverride, ToolArgError> {
    guard let info = voiceParamByName[param] else {
        return .failure(ToolArgError("INVALID_ARGUMENT", "unknown voice parameter \"\(param)\" (see gbk_get_voice_settings for the parameter list)"))
    }
    let gen = info.gen
    switch edit {
    case .set(let value):
        if let r = humanRange(gen: gen), value < r.min || value > r.max {
            return .failure(ToolArgError("INVALID_RANGE", "\(param) must be within [\(jsNum(round4(r.min))), \(jsNum(round4(r.max)))] \(info.unit)"))
        }
        return .success(VoiceOverride(gen: gen, mode: "set", value: humanToNative(gen: gen, value)))
    case .scale(let factor):
        if info.unit != "seconds" && info.unit != "Hz" {
            return .failure(ToolArgError("INVALID_ARGUMENT", "scale is only meaningful for time/frequency parameters (\(param) is \(info.unit)); use add instead"))
        }
        if !(factor > 0) || factor > 1024 { return .failure(ToolArgError("INVALID_RANGE", "scale factor must be in (0, 1024]")) }
        let v = (1200 * log2(factor)).rounded()
        return .success(VoiceOverride(gen: gen, mode: "add", value: v))
    case .add(let delta):
        if info.unit == "seconds" || info.unit == "Hz" {
            return .failure(ToolArgError("INVALID_ARGUMENT", "\(param) is measured in \(info.unit), which is logarithmic in the file; use scale (a factor) instead of add"))
        }
        return .success(VoiceOverride(gen: gen, mode: "add", value: humanToNative(gen: gen, delta)))
    }
}

/// Error carrying a protocol code, mirroring the TS WorkstationError/arg error shape.
struct ToolArgError: Error, Equatable, Sendable {
    var code: String
    var message: String
    var details: JSONValue?
    init(_ code: String, _ message: String, details: JSONValue? = nil) {
        self.code = code; self.message = message; self.details = details
    }
}
