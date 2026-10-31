import Foundation

/// Native port of src/workstation/model.ts. Ticks are authoritative; seconds are derived.
/// Value types throughout: assignment is the deep copy the web gets from structuredClone.
let projectSchemaVersion = 1

struct GNote: Equatable, Sendable {
    var id: String; var trackId: String; var channel: Int; var tick: Int; var duration: Int
    var pitch: Int; var velocity: Int; var offVelocity: Int?
}
struct CCEvent: Equatable, Sendable {
    var id: String; var trackId: String; var channel: Int; var controller: Int; var tick: Int; var value: Int
}
struct PitchBendEvent: Equatable, Sendable {
    var id: String; var trackId: String; var channel: Int; var tick: Int; var value: Int // 0..16383, 8192 center
}
struct ChannelPressureEvent: Equatable, Sendable {
    var id: String; var trackId: String; var channel: Int; var tick: Int; var value: Int
}
struct PolyPressureEvent: Equatable, Sendable {
    var id: String; var trackId: String; var channel: Int; var tick: Int; var pitch: Int; var value: Int
}
struct ProgramEvent: Equatable, Sendable {
    var id: String; var trackId: String; var channel: Int; var tick: Int; var program: Int; var bankMsb: Int; var bankLsb: Int
}
struct TempoEvent: Equatable, Sendable { var tick: Int; var microPerQuarter: Int }
struct TimeSigEvent: Equatable, Sendable { var tick: Int; var numerator: Int; var denominator: Int }
/// Events we do not model but must round-trip (sysex, unknown meta, text...). `bytes` excludes delta time.
struct RawEvent: Equatable, Sendable { var id: String; var trackId: String; var tick: Int; var bytes: [Int]; var kind: String }

struct TrackMix: Equatable, Sendable {
    var volume: Int = 100; var pan: Int = 64; var expression: Int = 127; var mute: Bool = false; var solo: Bool = false
    static let `default` = TrackMix()
}
struct GTrack: Equatable, Sendable {
    var id: String; var name: String; var channel: Int; var color: String; var mix: TrackMix; var visible: Bool; var role: String?
}
/// Semantic arrangement section (1-based bars, inclusive start, `bars` long).
struct Section: Equatable, Sendable { var name: String; var startBar: Int; var bars: Int; var energy: Double? }
struct SharedFrom: Equatable, Sendable { var slug: String; var title: String; var owner: String; var parentSlug: String? }
struct ProjectMeta: Equatable, Sendable {
    var key: String?; var sections: [Section]?; var descriptors: [String: String]?
    var owner: String? // "user" | "agent"
    var createdAt: Double?; var style: String?; var seed: Int?
    var sharedFrom: SharedFrom?
    var forkOf: String?
}
struct SoundSettings: Equatable, Sendable {
    var tracks: [String: [VoiceOverride]] = [:]
    var effects: EffectsParams?
}
struct Selection: Equatable, Sendable { var trackIds: [String] = []; var startTick: Int = 0; var endTick: Int = 0; var noteIds: [String] = [] }
struct LoopRange: Equatable, Sendable { var enabled: Bool = false; var startTick: Int = 0; var endTick: Int = 0 }

struct Project: Equatable, Sendable {
    var schemaVersion: Int = projectSchemaVersion
    var id: String
    var revision: Int = 0
    var name: String
    var ppq: Int = 480
    var format: Int = 1
    var tracks: [GTrack] = []
    var notes: [GNote] = []
    var ccs: [CCEvent] = []
    var pitchBends: [PitchBendEvent] = []
    var channelPressure: [ChannelPressureEvent] = []
    var polyPressure: [PolyPressureEvent] = []
    var programs: [ProgramEvent] = []
    var tempos: [TempoEvent] = [TempoEvent(tick: 0, microPerQuarter: 500000)]
    var timeSigs: [TimeSigEvent] = [TimeSigEvent(tick: 0, numerator: 4, denominator: 4)]
    var raw: [RawEvent] = []
    var endTick: Int = 0
    var selection = Selection()
    var loop = LoopRange()
    var sound: SoundSettings?
    var meta: ProjectMeta?
}

let trackColors = ["#4fc3f7", "#ffb74d", "#81c784", "#e57373", "#ba68c8", "#fff176", "#4db6ac", "#f06292",
                   "#a1887f", "#90a4ae", "#aed581", "#7986cb", "#ff8a65", "#9575cd", "#4dd0e1", "#dce775"]

private var idCounter = 0
func newStudioId(_ prefix: String) -> String {
    idCounter = (idCounter + 1) % 1_000_000_000
    let now = Int(Date().timeIntervalSince1970 * 1000)
    return "\(prefix)_\(String(now, radix: 36))\(String(idCounter, radix: 36))\(String(Int.random(in: 0..<1_000_000), radix: 36))"
}

func emptyProject(name: String = "Untitled", ppq: Int = 480) -> Project {
    Project(id: newStudioId("prj"), name: name, ppq: ppq)
}

func computeEndTick(_ p: Project) -> Int {
    var m = 0
    for n in p.notes { m = max(m, n.tick + n.duration) }
    for c in p.ccs { m = max(m, c.tick) }
    for b in p.pitchBends { m = max(m, b.tick) }
    for r in p.raw { m = max(m, r.tick) }
    return m
}

// MARK: - Project <-> JSONValue (the wire/persistence format, field-for-field with the TS model)

extension Project {
    var json: JSONValue {
        var o: [(String, JSONValue)] = [
            ("schemaVersion", .int(Int64(schemaVersion))), ("id", .string(id)), ("revision", .int(Int64(revision))),
            ("name", .string(name)), ("ppq", .int(Int64(ppq))), ("format", .int(Int64(format))),
            ("tracks", .array(tracks.map { $0.json })), ("notes", .array(notes.map { $0.json })),
            ("ccs", .array(ccs.map { $0.json })), ("pitchBends", .array(pitchBends.map { $0.json })),
            ("channelPressure", .array(channelPressure.map { $0.json })), ("polyPressure", .array(polyPressure.map { $0.json })),
            ("programs", .array(programs.map { $0.json })), ("tempos", .array(tempos.map { $0.json })),
            ("timeSigs", .array(timeSigs.map { $0.json })), ("raw", .array(raw.map { $0.json })),
            ("endTick", .int(Int64(endTick))),
            ("selection", .object([("trackIds", .array(selection.trackIds.map { .string($0) })), ("startTick", .int(Int64(selection.startTick))), ("endTick", .int(Int64(selection.endTick))), ("noteIds", .array(selection.noteIds.map { .string($0) }))])),
            ("loop", .object([("enabled", .bool(loop.enabled)), ("startTick", .int(Int64(loop.startTick))), ("endTick", .int(Int64(loop.endTick)))])),
        ]
        if let sound { o.append(("sound", sound.json)) }
        if let meta { o.append(("meta", meta.json)) }
        return .object(o)
    }

    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue, let name = json["name"]?.stringValue else { return nil }
        self.init(id: id, name: name)
        schemaVersion = json["schemaVersion"]?.intValue ?? 1
        revision = json["revision"]?.intValue ?? 0
        ppq = json["ppq"]?.intValue ?? 480
        format = json["format"]?.intValue ?? 1
        tracks = json["tracks"]?.arrayValue?.compactMap(GTrack.init(json:)) ?? []
        notes = json["notes"]?.arrayValue?.compactMap(GNote.init(json:)) ?? []
        ccs = json["ccs"]?.arrayValue?.compactMap(CCEvent.init(json:)) ?? []
        pitchBends = json["pitchBends"]?.arrayValue?.compactMap(PitchBendEvent.init(json:)) ?? []
        channelPressure = json["channelPressure"]?.arrayValue?.compactMap(ChannelPressureEvent.init(json:)) ?? []
        polyPressure = json["polyPressure"]?.arrayValue?.compactMap(PolyPressureEvent.init(json:)) ?? []
        programs = json["programs"]?.arrayValue?.compactMap(ProgramEvent.init(json:)) ?? []
        tempos = json["tempos"]?.arrayValue?.compactMap(TempoEvent.init(json:)) ?? tempos
        timeSigs = json["timeSigs"]?.arrayValue?.compactMap(TimeSigEvent.init(json:)) ?? timeSigs
        raw = json["raw"]?.arrayValue?.compactMap(RawEvent.init(json:)) ?? []
        endTick = json["endTick"]?.intValue ?? computeEndTick(self)
        if let s = json["selection"] {
            selection = Selection(trackIds: s["trackIds"]?.arrayValue?.compactMap { $0.stringValue } ?? [],
                                  startTick: s["startTick"]?.intValue ?? 0, endTick: s["endTick"]?.intValue ?? 0,
                                  noteIds: s["noteIds"]?.arrayValue?.compactMap { $0.stringValue } ?? [])
        }
        if let l = json["loop"] {
            loop = LoopRange(enabled: l["enabled"]?.boolValue ?? false, startTick: l["startTick"]?.intValue ?? 0, endTick: l["endTick"]?.intValue ?? 0)
        }
        if let s = json["sound"] { sound = SoundSettings(json: s) }
        if let m = json["meta"] { meta = ProjectMeta(json: m) }
    }
}

extension GTrack {
    var json: JSONValue {
        var o: [(String, JSONValue)] = [("id", .string(id)), ("name", .string(name)), ("channel", .int(Int64(channel))),
                                        ("color", .string(color)),
                                        ("mix", .object([("volume", .int(Int64(mix.volume))), ("pan", .int(Int64(mix.pan))), ("expression", .int(Int64(mix.expression))), ("mute", .bool(mix.mute)), ("solo", .bool(mix.solo))])),
                                        ("visible", .bool(visible))]
        if let role { o.append(("role", .string(role))) }
        return .object(o)
    }
    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue, let name = json["name"]?.stringValue else { return nil }
        let m = json["mix"]
        self.init(id: id, name: name, channel: json["channel"]?.intValue ?? 0,
                  color: json["color"]?.stringValue ?? "#90a4ae",
                  mix: TrackMix(volume: m?["volume"]?.intValue ?? 100, pan: m?["pan"]?.intValue ?? 64,
                                expression: m?["expression"]?.intValue ?? 127, mute: m?["mute"]?.boolValue ?? false,
                                solo: m?["solo"]?.boolValue ?? false),
                  visible: json["visible"]?.boolValue ?? true, role: json["role"]?.stringValue)
    }
}

extension GNote {
    var json: JSONValue {
        var o: [(String, JSONValue)] = [("id", .string(id)), ("trackId", .string(trackId)), ("channel", .int(Int64(channel))),
                                        ("tick", .int(Int64(tick))), ("duration", .int(Int64(duration))),
                                        ("pitch", .int(Int64(pitch))), ("velocity", .int(Int64(velocity)))]
        if let offVelocity { o.append(("offVelocity", .int(Int64(offVelocity)))) }
        return .object(o)
    }
    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue, let t = json["trackId"]?.stringValue else { return nil }
        self.init(id: id, trackId: t, channel: json["channel"]?.intValue ?? 0, tick: json["tick"]?.intValue ?? 0,
                  duration: json["duration"]?.intValue ?? 0, pitch: json["pitch"]?.intValue ?? 0,
                  velocity: json["velocity"]?.intValue ?? 0, offVelocity: json["offVelocity"]?.intValue)
    }
}

extension CCEvent {
    var json: JSONValue { .object([("id", .string(id)), ("trackId", .string(trackId)), ("channel", .int(Int64(channel))), ("controller", .int(Int64(controller))), ("tick", .int(Int64(tick))), ("value", .int(Int64(value)))]) }
    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue, let t = json["trackId"]?.stringValue else { return nil }
        self.init(id: id, trackId: t, channel: json["channel"]?.intValue ?? 0, controller: json["controller"]?.intValue ?? 0, tick: json["tick"]?.intValue ?? 0, value: json["value"]?.intValue ?? 0)
    }
}
extension PitchBendEvent {
    var json: JSONValue { .object([("id", .string(id)), ("trackId", .string(trackId)), ("channel", .int(Int64(channel))), ("tick", .int(Int64(tick))), ("value", .int(Int64(value)))]) }
    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue, let t = json["trackId"]?.stringValue else { return nil }
        self.init(id: id, trackId: t, channel: json["channel"]?.intValue ?? 0, tick: json["tick"]?.intValue ?? 0, value: json["value"]?.intValue ?? 0)
    }
}
extension ChannelPressureEvent {
    var json: JSONValue { .object([("id", .string(id)), ("trackId", .string(trackId)), ("channel", .int(Int64(channel))), ("tick", .int(Int64(tick))), ("value", .int(Int64(value)))]) }
    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue, let t = json["trackId"]?.stringValue else { return nil }
        self.init(id: id, trackId: t, channel: json["channel"]?.intValue ?? 0, tick: json["tick"]?.intValue ?? 0, value: json["value"]?.intValue ?? 0)
    }
}
extension PolyPressureEvent {
    var json: JSONValue { .object([("id", .string(id)), ("trackId", .string(trackId)), ("channel", .int(Int64(channel))), ("tick", .int(Int64(tick))), ("pitch", .int(Int64(pitch))), ("value", .int(Int64(value)))]) }
    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue, let t = json["trackId"]?.stringValue else { return nil }
        self.init(id: id, trackId: t, channel: json["channel"]?.intValue ?? 0, tick: json["tick"]?.intValue ?? 0, pitch: json["pitch"]?.intValue ?? 0, value: json["value"]?.intValue ?? 0)
    }
}
extension ProgramEvent {
    var json: JSONValue { .object([("id", .string(id)), ("trackId", .string(trackId)), ("channel", .int(Int64(channel))), ("tick", .int(Int64(tick))), ("program", .int(Int64(program))), ("bankMsb", .int(Int64(bankMsb))), ("bankLsb", .int(Int64(bankLsb)))]) }
    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue, let t = json["trackId"]?.stringValue else { return nil }
        self.init(id: id, trackId: t, channel: json["channel"]?.intValue ?? 0, tick: json["tick"]?.intValue ?? 0, program: json["program"]?.intValue ?? 0, bankMsb: json["bankMsb"]?.intValue ?? 0, bankLsb: json["bankLsb"]?.intValue ?? 0)
    }
}
extension TempoEvent {
    var json: JSONValue { .object([("tick", .int(Int64(tick))), ("microPerQuarter", .int(Int64(microPerQuarter)))]) }
    init?(json: JSONValue) {
        guard let t = json["tick"]?.intValue, let m = json["microPerQuarter"]?.intValue else { return nil }
        self.init(tick: t, microPerQuarter: m)
    }
}
extension TimeSigEvent {
    var json: JSONValue { .object([("tick", .int(Int64(tick))), ("numerator", .int(Int64(numerator))), ("denominator", .int(Int64(denominator)))]) }
    init?(json: JSONValue) {
        guard let t = json["tick"]?.intValue, let n = json["numerator"]?.intValue, let d = json["denominator"]?.intValue else { return nil }
        self.init(tick: t, numerator: n, denominator: d)
    }
}
extension RawEvent {
    var json: JSONValue { .object([("id", .string(id)), ("trackId", .string(trackId)), ("tick", .int(Int64(tick))), ("bytes", .array(bytes.map { .int(Int64($0)) })), ("kind", .string(kind))]) }
    init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue, let t = json["trackId"]?.stringValue else { return nil }
        self.init(id: id, trackId: t, tick: json["tick"]?.intValue ?? 0, bytes: json["bytes"]?.arrayValue?.compactMap { $0.intValue } ?? [], kind: json["kind"]?.stringValue ?? "other")
    }
}
extension Section {
    var json: JSONValue {
        var o: [(String, JSONValue)] = [("name", .string(name)), ("startBar", .int(Int64(startBar))), ("bars", .int(Int64(bars)))]
        if let energy { o.append(("energy", .number(energy))) }
        return .object(o)
    }
    init?(json: JSONValue) {
        guard let n = json["name"]?.stringValue, let s = json["startBar"]?.intValue, let b = json["bars"]?.intValue else { return nil }
        self.init(name: n, startBar: s, bars: b, energy: json["energy"]?.doubleValue)
    }
}
extension ProjectMeta {
    var json: JSONValue {
        var o: [(String, JSONValue)] = []
        if let key { o.append(("key", .string(key))) }
        if let sections { o.append(("sections", .array(sections.map { $0.json }))) }
        if let descriptors { o.append(("descriptors", .object(descriptors.sorted { $0.key < $1.key }.map { ($0.key, .string($0.value)) }))) }
        if let owner { o.append(("owner", .string(owner))) }
        if let createdAt { o.append(("createdAt", .number(createdAt))) }
        if let style { o.append(("style", .string(style))) }
        if let seed { o.append(("seed", .int(Int64(seed)))) }
        if let sharedFrom {
            var sf: [(String, JSONValue)] = [("slug", .string(sharedFrom.slug)), ("title", .string(sharedFrom.title)), ("owner", .string(sharedFrom.owner))]
            if let ps = sharedFrom.parentSlug { sf.append(("parentSlug", .string(ps))) } else { sf.append(("parentSlug", .null)) }
            o.append(("sharedFrom", .object(sf)))
        }
        if let forkOf { o.append(("forkOf", .string(forkOf))) }
        return .object(o)
    }
    init?(json: JSONValue) {
        self.init()
        key = json["key"]?.stringValue
        sections = json["sections"]?.arrayValue?.compactMap(Section.init(json:))
        if let d = json["descriptors"]?.objectValue { descriptors = Dictionary(uniqueKeysWithValues: d.compactMap { kv in kv.1.stringValue.map { (kv.0, $0) } }) }
        owner = json["owner"]?.stringValue
        createdAt = json["createdAt"]?.doubleValue
        style = json["style"]?.stringValue
        seed = json["seed"]?.intValue
        if let sf = json["sharedFrom"] {
            sharedFrom = SharedFrom(slug: sf["slug"]?.stringValue ?? "", title: sf["title"]?.stringValue ?? "",
                                    owner: sf["owner"]?.stringValue ?? "", parentSlug: sf["parentSlug"]?.stringValue)
        }
        forkOf = json["forkOf"]?.stringValue
    }
}
extension SoundSettings {
    var json: JSONValue {
        var o: [(String, JSONValue)] = [("tracks", .object(tracks.sorted { $0.key < $1.key }.map { ($0.key, .array($0.value.map { $0.json })) }))]
        if let effects { o.append(("effects", effects.json)) } else { o.append(("effects", .null)) }
        return .object(o)
    }
    init?(json: JSONValue) {
        self.init()
        if let t = json["tracks"]?.objectValue {
            for (k, v) in t { tracks[k] = v.arrayValue?.compactMap(VoiceOverride.init(json:)) ?? [] }
        }
        if let e = json["effects"], !e.isNull { effects = EffectsParams(json: e) }
    }
}
