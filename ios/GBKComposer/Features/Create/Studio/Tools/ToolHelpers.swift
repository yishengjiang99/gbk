import Foundation

// Shared helpers for the gbk_* tools — ports of the helper layer of src/webmcp/tools.ts,
// compose-tools.ts (trackOps / applied) and arrangement-tools.ts (keyOf).

func mNote(_ n: GNote) -> MNote { MNote(tick: n.tick, duration: n.duration, pitch: n.pitch, velocity: n.velocity) }
func mNotes(_ ns: [GNote]) -> [MNote] { ns.map(mNote) }

// MARK: - Ranges (tools.ts toTick / rangeToTicks)

struct TickRange { var startTick: Int; var endTick: Int }

func toTick(_ p: Project, unit: String, value: Double, isEnd: Bool = false) throws -> Int {
    switch unit {
    case "ticks": return Int(value.rounded())
    case "seconds": return secToTick(p, value)
    case "bars": return barBeatToTick(p, bar: Int(isEnd ? value + 1 : value))
    case "beats": return barBeatToTick(p, bar: 1, beat: value)
    default: throw ToolArgError("INVALID_ARGUMENT", "unknown unit \(unit)")
    }
}

func rangeArg(_ v: JSONValue?) -> (unit: String, start: Double, end: Double)? {
    guard let v, let unit = v.argStr("unit"), let start = v.argDbl("start"), let end = v.argDbl("end") else { return nil }
    return (unit, start, end)
}

func rangeToTicks(_ p: Project, _ r: (unit: String, start: Double, end: Double)) throws -> TickRange {
    let startTick = try toTick(p, unit: r.unit, value: r.start)
    let endTick = try toTick(p, unit: r.unit, value: r.end, isEnd: true)
    guard endTick > startTick else { throw ToolArgError("INVALID_RANGE", "range end must be after start") }
    return TickRange(startTick: startTick, endTick: endTick)
}

// MARK: - Track lookup (two message variants in the TS sources)

/// tools.ts trackOf / arrangement-tools findTrack: message names the unknown id.
func trackOf(_ p: Project, _ id: String) throws -> GTrack {
    if let t = p.tracks.first(where: { $0.id == id || $0.name.lowercased() == id.lowercased() }) { return t }
    throw ToolArgError("INVALID_ARGUMENT", "unknown track \(jsonStr(String(id.prefix(60)))); call gbk_list_tracks")
}

/// music-tools / sound-tools track(): bare message.
func trackOfPlain(_ p: Project, _ id: String) throws -> GTrack {
    if let t = p.tracks.first(where: { $0.id == id || $0.name.lowercased() == id.lowercased() }) { return t }
    throw ToolArgError("INVALID_ARGUMENT", "unknown track; call gbk_list_tracks")
}

/// JSON.stringify of a string (for error messages that embed ids like the TS sources do).
func jsonStr(_ s: String) -> String { JSONValue.string(s).serialized }

// MARK: - CC capability table (tools.ts CC_CAPS)

let ccCapsJSON: JSONValue = .object([
    ("1", .object([("name", .string("Modulation")), ("audible", .bool(true)), ("note", .string("SF2 default modulator -> vibrato LFO pitch depth"))])),
    ("7", .object([("name", .string("Volume")), ("audible", .bool(true))])),
    ("10", .object([("name", .string("Pan")), ("audible", .bool(true))])),
    ("11", .object([("name", .string("Expression")), ("audible", .bool(true))])),
    ("64", .object([("name", .string("Sustain")), ("audible", .bool(true))])),
    ("66", .object([("name", .string("Sostenuto")), ("audible", .bool(true))])),
    ("67", .object([("name", .string("Soft pedal")), ("audible", .bool(true))])),
    ("71", .object([("name", .string("Resonance")), ("audible", .bool(false)), ("note", .string("routed + stored; audible only if the preset defines a CC71 modulator"))])),
    ("74", .object([("name", .string("Brightness")), ("audible", .bool(false)), ("note", .string("routed + stored; audible only if the preset defines a CC74 modulator"))])),
    ("91", .object([("name", .string("Reverb send")), ("audible", .bool(true)), ("note", .string("SF2 2.01 default modulator 8.4.8: adds up to 20% reverb send (0.1% x 200 at CC 127) on top of the zone's reverbEffectsSend"))])),
    ("93", .object([("name", .string("Chorus send")), ("audible", .bool(true)), ("note", .string("SF2 2.01 default modulator 8.4.9: adds up to 20% chorus send on top of the zone's chorusEffectsSend"))])),
])

func ccWarn(_ cc: Int) -> [String] {
    guard let cap = ccCapsJSON[String(cc)] else {
        return ["CC\(cc) is stored and exported but has no built-in effect in the GBK SF2 engine"]
    }
    if cap["audible"]?.boolValue == true { return [] }
    return ["CC\(cc) (\(cap["name"]?.stringValue ?? "")): \(cap["note"]?.stringValue ?? "")"]
}

// MARK: - Project summary (tools.ts projectSummary)

func projectSummaryJSON(_ store: WorkstationStore) -> JSONValue {
    let p = store.project
    let est: KeyEstimate? = (p.meta?.key == nil && !p.notes.isEmpty) ? estimateKey(mNotes(p.notes)) : nil
    let keyJSON: JSONValue?
    if let k = p.meta?.key { keyJSON = .object([("name", .string(k)), ("estimated", .bool(false))]) }
    else if let est { keyJSON = .object([("name", .string(est.label)), ("estimated", .bool(true))]) }
    else { keyJSON = nil }
    let tracksJSON: [JSONValue] = p.tracks.map { t in
        var noteCount = 0; var minPitch: Int? = nil; var maxPitch: Int? = nil
        for n in p.notes where n.trackId == t.id {
            noteCount += 1
            minPitch = minPitch.map { min($0, n.pitch) } ?? n.pitch
            maxPitch = maxPitch.map { max($0, n.pitch) } ?? n.pitch
        }
        let prog = p.programs.first { $0.trackId == t.id }
        return jsonObj([
            ("id", .string(t.id)), ("name", .string(t.name)), ("channel", .int(Int64(t.channel))),
            ("program", prog.map { .object([("program", .int(Int64($0.program))), ("bankMsb", .int(Int64($0.bankMsb))), ("bankLsb", .int(Int64($0.bankLsb)))]) }),
            ("isPercussion", .bool(t.channel == 9 || t.role == "percussion")),
            ("noteCount", .int(Int64(noteCount))),
            ("minPitch", minPitch.map { .int(Int64($0)) }), ("maxPitch", maxPitch.map { .int(Int64($0)) }),
        ])
    }
    return jsonObj([
        ("name", .string(p.name)), ("ppq", .int(Int64(p.ppq))), ("revision", .int(Int64(p.revision))),
        ("endTick", .int(Int64(p.endTick))), ("durationSec", jsonFixed3(tickToSec(p, p.endTick))),
        ("bars", .int(Int64(tickToBarBeat(p, p.endTick).bar))),
        ("tempos", .array(p.tempos.prefix(32).map { $0.json })),
        ("timeSigs", .array(p.timeSigs.prefix(32).map { $0.json })),
        ("trackCount", .int(Int64(p.tracks.count))), ("noteCount", .int(Int64(p.notes.count))), ("ccCount", .int(Int64(p.ccs.count))),
        ("pendingProposals", .array(store.proposals.filter { $0.status == "pending" }.map {
            .object([("id", .string($0.id)), ("summary", .string($0.summary))])
        })),
        ("key", keyJSON),
        ("sections", .array((p.meta?.sections ?? []).map { $0.json })),
        ("tracks", .array(tracksJSON)),
    ])
}

// MARK: - Proposal view (tools.ts proposalView)

func proposalViewJSON(_ pr: Proposal) -> JSONValue {
    .object([
        ("proposalId", .string(pr.id)),
        ("baseRevision", .int(Int64(pr.baseRevision))),
        ("summary", .string(pr.summary)),
        ("range", .object([("startTick", .int(Int64(pr.rangeStartTick))), ("endTick", .int(Int64(pr.rangeEndTick)))])),
        ("trackIds", .array(pr.trackIds.map { .string($0) })),
        ("status", .string(pr.status)),
        ("validation", .object([("ok", .bool(true)), ("warnings", .array(pr.warnings.map { .string($0) }))])),
        ("next", .string("Call gbk_preview_proposal for A/B, then gbk_commit_proposal (user approves) or gbk_discard_proposal.")),
    ])
}

// MARK: - applied() (compose-tools.ts): committed in an autonomous session, else a proposal

func appliedResult(_ store: WorkstationStore, _ ops: [ProjectOp], label: String, baseRevision: Int? = nil, extra: [(String, JSONValue)] = []) throws -> ToolRunOut {
    switch try store.agentApply(ops, label: label, baseRevision: baseRevision) {
    case .committed(let revision, let warnings):
        var pairs: [(String, JSONValue)] = [("committed", .bool(true)), ("revision", .int(Int64(revision)))]
        pairs.append(contentsOf: extra)
        return ToolRunOut(data: .object(pairs), warnings: warnings)
    case .proposal(let pr):
        var pairs: [(String, JSONValue?)] = [("committed", .bool(false))]
        if case .object(let viewPairs) = proposalViewJSON(pr) { pairs.append(contentsOf: viewPairs.map { ($0.0, $0.1 as JSONValue?) }) }
        pairs.append(contentsOf: extra.map { ($0.0, $0.1 as JSONValue?) })
        pairs.append(("note", .string("This project is not an agent-owned project in an active autonomous session, so the change is a proposal the user must Accept.")))
        return ToolRunOut(data: jsonObj(pairs), warnings: pr.warnings)
    }
}

// MARK: - trackOps (compose-tools.ts): channel assignment + SoundFont program checks

struct TrackInput {
    var name: String
    var channel: Int? = nil
    var program: Int? = nil
    var bankMsb: Int? = nil
    var bankLsb: Int? = nil
    var role: String? = nil
    var volume: Int? = nil
    var pan: Int? = nil
    var expression: Int? = nil
    var id: String? = nil
}

func trackInputFromJSON(_ v: JSONValue) -> TrackInput {
    TrackInput(name: v.argStr("name") ?? "", channel: v.argInt("channel"), program: v.argInt("program"),
               bankMsb: v.argInt("bankMsb"), bankLsb: v.argInt("bankLsb"), role: v.argStr("role"),
               volume: v.argInt("volume"), pan: v.argInt("pan"), expression: v.argInt("expression"), id: v.argStr("id"))
}

let trackRoles = ["melody", "harmony", "bass", "counterpoint", "accompaniment", "percussion", "pad", "other"] // ops.ts TRACK_ROLES

/// Resolve a program against the host's preset list (port of resolveInstrument's warning behavior).
func resolveInstrumentWarning(_ store: WorkstationStore, program: Int, bankMsb: Int, channel: Int, bankLsb: Int) throws -> String? {
    guard let presets = store.host.listPresets?() else { return nil }
    let bank = channel == 9 ? 128 : bankMsb
    func find(_ bank: Int, _ program: Int) -> JSONValue? {
        presets.first { $0["bank"]?.intValue == bank && $0["program"]?.intValue == program }
    }
    if find(bank, program) != nil { return nil }
    if channel == 9, let fallback = find(128, 0) {
        let name = fallback["name"]?.stringValue ?? ""
        return "bank \(bank)\(bankLsb != 0 ? "/\(bankLsb)" : "") program \(program) (ch\(channel + 1)) not in SoundFont; using \"\(name)\" (bank \(fallback["bank"]?.intValue ?? 128) program \(fallback["program"]?.intValue ?? 0))"
    }
    if let fallback = find(0, program) {
        let name = fallback["name"]?.stringValue ?? ""
        return "bank \(bank)\(bankLsb != 0 ? "/\(bankLsb)" : "") program \(program) (ch\(channel + 1)) not in SoundFont; using \"\(name)\" (bank 0 program \(program))"
    }
    throw ToolArgError("INSTRUMENT_NOT_FOUND", "no preset for bank \(bank) program \(program) (and no bank-0 fallback) in this SoundFont")
}

func trackOps(_ store: WorkstationStore, _ p: Project, _ inputs: [TrackInput]) throws -> (ops: [ProjectOp], ids: [String], warnings: [String]) {
    var used = Set(p.tracks.map { $0.channel })
    var warnings: [String] = []
    var ops: [ProjectOp] = []
    var ids: [String] = []
    let hasFont = (store.host.listPresets?().isEmpty == false)
    for t in inputs {
        let perc = t.role == "percussion"
        var ch: Int
        if let given = t.channel {
            ch = given
            if used.contains(ch) && ch != 9 {
                warnings.append("channel \(ch + 1) is already used by another track: CC/pitch-bend state is shared on a MIDI channel")
            }
        } else if perc {
            ch = 9
        } else if let free = (0..<16).first(where: { $0 != 9 && !used.contains($0) }) {
            ch = free
        } else {
            throw ToolArgError("INVALID_ARGUMENT", "no free MIDI channel left; pass channel explicitly to share one (tracks on one channel share controller state)")
        }
        if perc && ch != 9 { warnings.append("\"\(t.name)\" has role percussion but channel \(ch + 1); GM drums are on channel 10 (index 9)") }
        used.insert(ch)
        let program = t.program ?? 0
        if hasFont {
            if let w = try resolveInstrumentWarning(store, program: program, bankMsb: t.bankMsb ?? 0, channel: ch, bankLsb: t.bankLsb ?? 0) { warnings.append(w) }
        } else {
            warnings.append("SoundFont not loaded yet: bank/program for \"\(t.name)\" is validated when rendering")
        }
        let id = t.id ?? newStudioId("trk")
        ids.append(id)
        // TS ops.ts: color = TRACK_COLORS[tracks.length % len] at apply time; the TS addTrack op
        // also writes the tick-0 program event, which the Swift ops layer does via setProgram.
        let color = trackColors[(p.tracks.count + ids.count - 1) % trackColors.count]
        let track = GTrack(id: id, name: t.name, channel: ch, color: color, mix: TrackMix(volume: t.volume ?? 100, pan: t.pan ?? 64, expression: t.expression ?? 127, mute: false, solo: false), visible: true, role: t.role)
        ops.append(.addTrack(track, index: nil))
        ops.append(.setProgram(trackId: id, program: program, bankMsb: t.bankMsb ?? 0, bankLsb: t.bankLsb ?? 0, tick: 0))
    }
    return (ops, ids, warnings)
}

// MARK: - keyOf (arrangement-tools.ts)

func keyOf(_ p: Project, _ k: String?) throws -> KeyInfo {
    if let k { return try parseKeyInfo(k) }
    if let metaKey = p.meta?.key, let parsed = try? parseKeyInfo(metaKey) { return parsed }
    let e = estimateKey(mNotes(p.notes))
    return KeyInfo(label: e.label, tonic: e.tonic, mode: e.mode, sf: 0)
}

func sessionJSON(_ s: AutonomousSession?) -> JSONValue {
    guard let s else { return .null }
    return .object([
        ("id", .string(s.id)), ("projectId", .string(s.projectId)),
        ("createdAt", .number(s.createdAt)), ("expiresAt", .number(s.expiresAt)),
        ("active", .bool(s.active)), ("purpose", .string(s.purpose)), ("baseRevision", .int(Int64(s.baseRevision))),
    ])
}
