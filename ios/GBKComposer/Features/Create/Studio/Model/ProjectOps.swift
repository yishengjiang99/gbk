import Foundation

/// Port of src/workstation/ops.ts: the single mutation vocabulary for user, hum, scan and agent edits.

struct NotePatch: Sendable {
    var trackId: String?; var channel: Int?; var tick: Int?; var duration: Int?; var pitch: Int?
    var velocity: Int?; var offVelocity: Int??
}
struct TrackPatch: Sendable {
    var name: String?; var channel: Int?; var color: String?
    var volume: Int?; var pan: Int?; var expression: Int?; var mute: Bool?; var solo: Bool?
    var visible: Bool?; var role: String??
}

enum ProjectOp: Sendable {
    case addNotes([GNote])
    case removeNotes(Set<String>)
    case updateNotes([(id: String, patch: NotePatch)])
    case setCC(trackId: String, controller: Int, points: [CCEvent], mode: String)
    case removeCC(trackId: String, controller: Int, fromTick: Int, toTick: Int)
    case addPitchBends([PitchBendEvent])
    case updateTrack(id: String, patch: TrackPatch)
    case addTrack(GTrack, index: Int?)
    case setTempoMap([TempoEvent])
    case setTimeSigMap([TimeSigEvent])
    case setSections([Section]?)
    case setMeta(ProjectMeta?)
    case setProgram(trackId: String, program: Int, bankMsb: Int, bankLsb: Int, tick: Int)
    case setVoicePatch(trackId: String, overrides: [VoiceOverride], merge: Bool)
    case setEffects(EffectsParams?)
}

private func intIn(_ v: Int, _ lo: Int, _ hi: Int, _ name: String) throws {
    if v < lo || v > hi { throw ToolArgError("INVALID_RANGE", "\(name) \(v) out of range [\(lo), \(hi)]") }
}

/// Validates a batch; returns advisory warnings. Throws ToolArgError like the TS WorkstationError.
func validateProjectOps(_ p: Project, _ ops: [ProjectOp]) throws -> [String] {
    var warnings: [String] = []
    let trackIds = Set(p.tracks.map { $0.id })
    func knownTrack(_ id: String) throws {
        if !trackIds.contains(id) { throw ToolArgError("INVALID_ARGUMENT", "unknown track \(id)") }
    }
    for op in ops {
        switch op {
        case .addNotes(let notes):
            for n in notes {
                try knownTrack(n.trackId)
                try intIn(n.channel, 0, 15, "channel"); try intIn(n.tick, 0, Int.max, "tick")
                try intIn(n.duration, 1, Int.max, "duration"); try intIn(n.pitch, 0, 127, "pitch")
                try intIn(n.velocity, 1, 127, "velocity")
                if let ov = n.offVelocity { try intIn(ov, 0, 127, "offVelocity") }
            }
        case .removeNotes(let ids):
            let have = Set(p.notes.map { $0.id })
            for id in ids where !have.contains(id) { throw ToolArgError("INVALID_ARGUMENT", "cannot remove unknown note \(id)") }
        case .updateNotes(let patches):
            let have = Set(p.notes.map { $0.id })
            for (id, patch) in patches {
                if !have.contains(id) { throw ToolArgError("INVALID_ARGUMENT", "cannot update unknown note \(id)") }
                if let t = patch.trackId { try knownTrack(t) }
                if let v = patch.channel { try intIn(v, 0, 15, "channel") }
                if let v = patch.tick { try intIn(v, 0, Int.max, "tick") }
                if let v = patch.duration { try intIn(v, 1, Int.max, "duration") }
                if let v = patch.pitch { try intIn(v, 0, 127, "pitch") }
                if let v = patch.velocity { try intIn(v, 1, 127, "velocity") }
                if let ov = patch.offVelocity, let v = ov { try intIn(v, 0, 127, "offVelocity") }
            }
        case .setCC(let trackId, let controller, let points, _):
            try knownTrack(trackId); try intIn(controller, 0, 127, "controller")
            if controller == 0 || controller == 32 || controller == 98 || controller == 99 || controller == 100 || controller == 101 {
                warnings.append("controller \(controller) is normally managed by instrument/bank selection; the points were kept as authored")
            }
            for pt in points {
                try intIn(pt.tick, 0, Int.max, "tick"); try intIn(pt.value, 0, 127, "value"); try intIn(pt.channel, 0, 15, "channel")
            }
        case .removeCC(_, let controller, let fromTick, let toTick):
            try intIn(controller, 0, 127, "controller")
            if fromTick > toTick { throw ToolArgError("INVALID_RANGE", "removeCC range is empty") }
        case .addPitchBends(let bends):
            for b in bends { try knownTrack(b.trackId); try intIn(b.value, 0, 16383, "pitch bend"); try intIn(b.tick, 0, Int.max, "tick") }
        case .updateTrack(let id, let patch):
            try knownTrack(id)
            if let v = patch.channel { try intIn(v, 0, 15, "channel") }
            if let v = patch.volume { try intIn(v, 0, 127, "volume") }
            if let v = patch.pan { try intIn(v, 0, 127, "pan") }
            if let v = patch.expression { try intIn(v, 0, 127, "expression") }
            if let n = patch.name, n.isEmpty { throw ToolArgError("INVALID_ARGUMENT", "track name must not be empty") }
        case .addTrack(let t, _):
            if trackIds.contains(t.id) { throw ToolArgError("INVALID_ARGUMENT", "track id \(t.id) already exists") }
            try intIn(t.channel, 0, 15, "channel")
        case .setTempoMap(let map):
            if map.isEmpty || map.count > 1024 { throw ToolArgError("INVALID_RANGE", "tempo map must have 1..1024 events") }
            if map[0].tick != 0 { throw ToolArgError("INVALID_RANGE", "tempo map must start at tick 0") }
            for i in map.indices {
                try intIn(map[i].microPerQuarter, 10000, 10000000, "microPerQuarter")
                if i > 0 && map[i].tick <= map[i - 1].tick { throw ToolArgError("INVALID_RANGE", "tempo map ticks must be strictly increasing") }
            }
        case .setTimeSigMap(let map):
            if map.isEmpty || map.count > 1024 { throw ToolArgError("INVALID_RANGE", "time signature map must have 1..1024 events") }
            if map[0].tick != 0 { throw ToolArgError("INVALID_RANGE", "time signature map must start at tick 0") }
            for i in map.indices {
                try intIn(map[i].numerator, 1, 32, "numerator")
                if ![1, 2, 4, 8, 16, 32].contains(map[i].denominator) { throw ToolArgError("INVALID_RANGE", "denominator must be a power of two") }
                if i > 0 && map[i].tick <= map[i - 1].tick { throw ToolArgError("INVALID_RANGE", "time signature ticks must be strictly increasing") }
            }
        case .setSections(let sections):
            if let sections {
                if sections.count > 256 { throw ToolArgError("INVALID_RANGE", "at most 256 sections") }
                var prevEnd = 0
                for s in sections.sorted(by: { $0.startBar < $1.startBar }) {
                    if s.startBar < 1 { throw ToolArgError("INVALID_RANGE", "section startBar must be >= 1") }
                    if s.bars < 1 { throw ToolArgError("INVALID_RANGE", "section bars must be >= 1") }
                    if s.startBar < prevEnd { throw ToolArgError("INVALID_RANGE", "sections must not overlap") }
                    prevEnd = s.startBar + s.bars
                }
            }
        case .setMeta:
            break
        case .setProgram(let trackId, let program, let bankMsb, let bankLsb, _):
            try knownTrack(trackId)
            try intIn(program, 0, 127, "program"); try intIn(bankMsb, 0, 127, "bankMsb"); try intIn(bankLsb, 0, 127, "bankLsb")
        case .setVoicePatch(let trackId, let overrides, _):
            try knownTrack(trackId)
            for o in overrides {
                if let e = validateOverride(o) { throw ToolArgError("INVALID_ARGUMENT", e) }
            }
        case .setEffects:
            break
        }
    }
    return warnings
}

/// Pure application: returns a NEW project (the TS applyOps). Notes stay sorted by (tick, pitch).
func applyProjectOps(_ project: Project, _ ops: [ProjectOp]) -> Project {
    var p = project
    for op in ops {
        switch op {
        case .addNotes(let notes):
            p.notes.append(contentsOf: notes)
            p.notes.sort { ($0.tick, $0.pitch) < ($1.tick, $1.pitch) }
        case .removeNotes(let ids):
            p.notes.removeAll { ids.contains($0.id) }
        case .updateNotes(let patches):
            let byId = Dictionary(uniqueKeysWithValues: patches.map { ($0.id, $0.patch) })
            p.notes = p.notes.map { n in
                guard let patch = byId[n.id] else { return n }
                var m = n
                if let v = patch.trackId { m.trackId = v }
                if let v = patch.channel { m.channel = v }
                if let v = patch.tick { m.tick = v }
                if let v = patch.duration { m.duration = v }
                if let v = patch.pitch { m.pitch = v }
                if let v = patch.velocity { m.velocity = v }
                if let ov = patch.offVelocity { m.offVelocity = ov }
                return m
            }
            p.notes.sort { ($0.tick, $0.pitch) < ($1.tick, $1.pitch) }
        case .setCC(let trackId, let controller, let points, let mode):
            if mode == "replace", let lo = points.map({ $0.tick }).min(), let hi = points.map({ $0.tick }).max() {
                p.ccs.removeAll { $0.trackId == trackId && $0.controller == controller && $0.tick >= lo && $0.tick <= hi }
            } else {
                let ticks = Set(points.map { $0.tick })
                p.ccs.removeAll { $0.trackId == trackId && $0.controller == controller && ticks.contains($0.tick) }
            }
            p.ccs.append(contentsOf: points)
            p.ccs.sort { ($0.tick, $0.controller) < ($1.tick, $1.controller) }
        case .removeCC(let trackId, let controller, let fromTick, let toTick):
            p.ccs.removeAll { $0.trackId == trackId && $0.controller == controller && $0.tick >= fromTick && $0.tick <= toTick }
        case .addPitchBends(let bends):
            p.pitchBends.append(contentsOf: bends)
            p.pitchBends.sort { $0.tick < $1.tick }
        case .updateTrack(let id, let patch):
            if let i = p.tracks.firstIndex(where: { $0.id == id }) {
                var t = p.tracks[i]
                if let v = patch.name { t.name = v }
                if let v = patch.channel { t.channel = v }
                if let v = patch.color { t.color = v }
                if let v = patch.volume { t.mix.volume = v }
                if let v = patch.pan { t.mix.pan = v }
                if let v = patch.expression { t.mix.expression = v }
                if let v = patch.mute { t.mix.mute = v }
                if let v = patch.solo { t.mix.solo = v }
                if let v = patch.visible { t.visible = v }
                if let r = patch.role { t.role = r }
                p.tracks[i] = t
            }
        case .addTrack(let t, let index):
            if let index, index >= 0, index <= p.tracks.count { p.tracks.insert(t, at: index) } else { p.tracks.append(t) }
        case .setTempoMap(let map):
            p.tempos = map.sorted { $0.tick < $1.tick }
        case .setTimeSigMap(let map):
            p.timeSigs = map.sorted { $0.tick < $1.tick }
        case .setSections(let sections):
            if p.meta == nil { p.meta = ProjectMeta() }
            p.meta?.sections = sections
        case .setMeta(let meta):
            p.meta = meta
        case .setProgram(let trackId, let program, let bankMsb, let bankLsb, let tick):
            guard let track = p.tracks.first(where: { $0.id == trackId }) else { break }
            p.programs.removeAll { $0.trackId == trackId && $0.tick == tick }
            p.programs.append(ProgramEvent(id: newStudioId("pgm"), trackId: trackId, channel: track.channel, tick: tick, program: program, bankMsb: bankMsb, bankLsb: bankLsb))
            p.programs.sort { $0.tick < $1.tick }
            // Bank select is part of the program event now; drop hand-authored bank CCs at that tick.
            p.ccs.removeAll { $0.trackId == trackId && ($0.controller == 0 || $0.controller == 32) && $0.tick == tick }
        case .setVoicePatch(let trackId, let overrides, let merge):
            if p.sound == nil { p.sound = SoundSettings() }
            if merge {
                var cur = p.sound!.tracks[trackId] ?? []
                for o in overrides {
                    cur.removeAll { $0.gen == o.gen && $0.keyLo == o.keyLo && $0.keyHi == o.keyHi }
                    cur.append(o)
                }
                p.sound!.tracks[trackId] = cur
            } else {
                p.sound!.tracks[trackId] = overrides
            }
        case .setEffects(let fx):
            if p.sound == nil { p.sound = SoundSettings() }
            p.sound!.effects = fx
        }
    }
    p.endTick = computeEndTick(p)
    return p
}

/// Human one-liners for proposal cards and activity logs (summarizeOps in ops.ts).
func summarizeOps(_ p: Project, _ ops: [ProjectOp]) -> [String] {
    func tname(_ id: String) -> String { p.tracks.first { $0.id == id }?.name ?? id }
    return ops.map { op in
        switch op {
        case .addNotes(let n): return "Add \(n.count) note\(n.count == 1 ? "" : "s")"
        case .removeNotes(let ids): return "Remove \(ids.count) note\(ids.count == 1 ? "" : "s")"
        case .updateNotes(let u): return "Update \(u.count) note\(u.count == 1 ? "" : "s")"
        case .setCC(_, let c, let pts, _): return "Set CC \(c) (\(pts.count) points)"
        case .removeCC(_, let c, _, _): return "Remove CC \(c)"
        case .addPitchBends(let b): return "Add \(b.count) pitch bends"
        case .updateTrack(let id, _): return "Update track \"\(tname(id))\""
        case .addTrack(let t, _): return "Add track \"\(t.name)\""
        case .setTempoMap(let m): return "Set tempo map (\(m.count) change\(m.count == 1 ? "" : "s"))"
        case .setTimeSigMap(let m): return "Set time signature (\(m.count) change\(m.count == 1 ? "" : "s"))"
        case .setSections(let s): return "Set sections (\(s?.count ?? 0))"
        case .setMeta: return "Replace song info"
        case .setProgram(let trackId, let program, _, _, _): return "Set \(tname(trackId)) to program \(program)"
        case .setVoicePatch(let trackId, let ovs, _): return "Sound patch for \(tname(trackId)) (\(ovs.count) change\(ovs.count == 1 ? "" : "s"))"
        case .setEffects: return "Set effects"
        }
    }
}
