import Foundation

// Port of buildCoreTools in src/webmcp/tools.ts.

private let noteSchema = schemaObj([
    ("trackId", schemaStr()), ("tick", schemaInt(0, 1_000_000_000)), ("duration", schemaInt(1, 1_000_000_000)),
    ("pitch", schemaInt(0, 127)), ("velocity", schemaInt(1, 127)),
    ("channel", schemaInt(0, 15, "defaults to the track channel")),
], required: ["trackId", "tick", "duration", "pitch", "velocity"])

func transportJSON(_ store: WorkstationStore) -> JSONValue {
    let t = store.transport
    return jsonObj([
        ("playing", .bool(t.playing)), ("positionTick", .int(Int64(t.positionTick))),
        ("audioReady", .bool(t.audioReady)), ("starting", .bool(t.starting)),
        ("sf2Progress", t.sf2Progress.map { .number($0) } ?? .null),
    ])
}

func mixJSON(_ m: TrackMix) -> JSONValue {
    .object([("volume", .int(Int64(m.volume))), ("pan", .int(Int64(m.pan))), ("expression", .int(Int64(m.expression))),
             ("mute", .bool(m.mute)), ("solo", .bool(m.solo))])
}

func overrideJSON(_ patch: TrackPatch?) -> JSONValue {
    guard let patch else { return .null }
    return jsonObj([
        ("volume", patch.volume.map { .int(Int64($0)) }), ("pan", patch.pan.map { .int(Int64($0)) }),
        ("expression", patch.expression.map { .int(Int64($0)) }), ("mute", patch.mute.map { .bool($0) }),
        ("solo", patch.solo.map { .bool($0) }),
    ])
}

/// setCC with an explicit replace range, composed from the Swift ops (whose replace range is
/// derived from the points span): removeCC over [start, end) + a merge insert — the TS semantics.
func setCCOps(trackId: String, channel: Int, controller: Int, range: TickRange, mode: String, points: [CCEvent]) -> [ProjectOp] {
    if mode == "replace" {
        return [.removeCC(trackId: trackId, controller: controller, fromTick: range.startTick, toTick: range.endTick - 1),
                .setCC(trackId: trackId, controller: controller, points: points, mode: "merge")]
    }
    return [.setCC(trackId: trackId, controller: controller, points: points, mode: "merge")]
}

func buildCoreTools(_ store: WorkstationStore) -> [GBKTool] {
    let P = { store.project }
    return [
        GBKTool(name: "gbk_get_capabilities", description: "What this GBK build can and cannot do (implemented tools, audible vs stored-only CCs, audio readiness).", inputSchema: schemaObj([]), readOnly: true) { _ in
            ToolRunOut(data: jsonObj([
                ("audioReady", .bool(store.transport.audioReady)),
                ("controllers", ccCapsJSON),
                ("otherControllers", .string("CC 0-127 are preserved, scheduled and exported; unlisted CCs only matter if the SoundFont preset maps them")),
                ("pitchBend", .string("14-bit, audible (default range 2 semitones, RPN0 supported)")),
                ("pressure", .string("channel + poly pressure routed to SF2 modulators")),
                ("effects", .object([
                    ("reverb", .string("Freeverb-style stereo (8 combs + 4 allpasses), driven per voice by SF2 reverbEffectsSend (gen 16) + CC91; params via gbk_set_effects")),
                    ("chorus", .string("two quadrature-modulated delay lines, driven by chorusEffectsSend (gen 15) + CC93")),
                    ("offlineWav", .bool(true)), ("deterministic", .bool(true)),
                ])),
                ("voiceEditing", .object([
                    ("tools", .array([.string("gbk_get_voice_settings"), .string("gbk_propose_voice_patch"), .string("gbk_set_effects")])),
                    ("scope", .string("per track, optional key range; applied at note-on (realtime generators also update sounding notes)")),
                    ("midiExport", .string("additive overrides without key range export as SF2 NRPNs (CC99=120); absolute / key-ranged overrides and effects params are project-only")),
                ])),
                ("unsupported", .array([.string("arbitrary JS/DOM/filesystem/network"), .string("per-preset effects types / GS-XG effect macros"), .string("SMPTE time division")])),
                ("approval", .string("commit_proposal from an agent requires the user to press Accept in the GBK proposal panel")),
            ]))
        },
        GBKTool(name: "gbk_get_project_summary", description: "Project summary: name, key (declared, or estimated and flagged), sections, per-track program/percussion/note counts/pitch ranges, PPQ, tempo/meter maps, counts, revision, pending proposals.", inputSchema: schemaObj([]), readOnly: true) { _ in
            ToolRunOut(data: projectSummaryJSON(store))
        },
        GBKTool(name: "gbk_get_score_digest", description: "Compact score digest (#162 tier 2): per track, one entry per non-empty bar (pitch classes present, pitch range, note count, mean velocity) plus a per-bar chord estimate from all tracks. Read this BEFORE gbk_get_notes for interpretive work - a whole symphony digests to a few hundred entries instead of ~55 paged note calls.", inputSchema: schemaObj([
            ("range", rangeSchema),
            ("trackIds", schemaArray(items: schemaStr(), maxItems: 64)),
        ]), readOnly: true) { a in
            let p = P()
            let r = try a.argObj("range").flatMap(rangeArg).map { try rangeToTicks(p, $0) } ?? TickRange(startTick: 0, endTick: max(p.endTick, 1))
            let ids = a.argStrs("trackIds")
            let tracks = p.tracks.filter { ids == nil || ids!.contains($0.id) }
            struct Agg { var pcs = Set<Int>(); var min = 0; var max = 0; var count = 0; var vel = 0 }
            var byTrack: [String: [Int: Agg]] = [:]
            var barPcs: [Int: Set<Int>] = [:]
            for n in p.notes where n.tick >= r.startTick && n.tick < r.endTick {
                let bar = tickToBarBeat(p, n.tick).bar
                var m = byTrack[n.trackId] ?? [:]
                var e = m[bar] ?? Agg(min: n.pitch, max: n.pitch)
                let pc = ((n.pitch % 12) + 12) % 12
                e.pcs.insert(pc); e.min = min(e.min, n.pitch); e.max = max(e.max, n.pitch); e.count += 1; e.vel += n.velocity
                m[bar] = e; byTrack[n.trackId] = m
                barPcs[bar, default: []].insert(pc)
            }
            var chords: [(String, JSONValue)] = []
            for (bar, pcs) in barPcs.sorted(by: { $0.key < $1.key }) {
                if let ch = estimateChord(pcs: pcs.sorted()) { chords.append((String(bar), .string(ch.label))) }
            }
            var budget = 1000; var truncated = false
            let outTracks: [JSONValue] = tracks.map { t in
                let bars = (byTrack[t.id] ?? [:]).sorted { $0.key < $1.key }.map { (bar, e) in
                    jsonObj([
                        ("bar", .int(Int64(bar))), ("pitchClasses", .array(e.pcs.sorted().map { .int(Int64($0)) })),
                        ("minPitch", .int(Int64(e.min))), ("maxPitch", .int(Int64(e.max))),
                        ("noteCount", .int(Int64(e.count))), ("meanVelocity", .int(Int64(e.count > 0 ? Int((Double(e.vel) / Double(e.count)).rounded()) : 0))),
                    ])
                }
                let kept = Array(bars.prefix(max(0, budget)))
                if kept.count < bars.count { truncated = true }
                budget -= kept.count
                return jsonObj([
                    ("id", .string(t.id)), ("name", .string(t.name)),
                    ("isPercussion", .bool(t.channel == 9 || t.role == "percussion")),
                    ("bars", .array(kept)),
                ])
            }
            return ToolRunOut(data: .object([
                ("range", .object([("startTick", .int(Int64(r.startTick))), ("endTick", .int(Int64(r.endTick)))])),
                ("chords", .object(chords)),
                ("tracks", .array(outTracks)),
            ]), warnings: truncated ? ["digest truncated at 1000 bar entries - narrow the range or trackIds"] : [])
        },
        GBKTool(name: "gbk_list_tracks", description: "Tracks with stable ids, names, channels, mix defaults, note counts and program.", inputSchema: schemaObj([]), readOnly: true) { _ in
            let p = P()
            return ToolRunOut(data: .array(p.tracks.map { t in
                jsonObj([
                    ("id", .string(t.id)), ("name", .string(t.name)), ("channel", .int(Int64(t.channel))),
                    ("mix", mixJSON(t.mix)), ("override", overrideJSON(store.overrides[t.id])),
                    ("visible", .bool(t.visible)),
                    ("notes", .int(Int64(p.notes.filter { $0.trackId == t.id }.count))),
                    ("program", p.programs.first { $0.trackId == t.id }?.json ?? .null),
                ])
            }))
        },
        GBKTool(name: "gbk_get_notes", description: "Notes filtered by range/tracks/pitch, paginated (max 500 per page).", inputSchema: schemaObj([
            ("range", rangeSchema),
            ("trackIds", schemaArray(items: schemaStr(), maxItems: 64)),
            ("minPitch", schemaInt(0, 127)), ("maxPitch", schemaInt(0, 127)),
            ("offset", schemaInt(0, 10_000_000)), ("limit", schemaInt(1, 500)),
        ]), readOnly: true) { a in
            let p = P()
            let r = try a.argObj("range").flatMap(rangeArg).map { try rangeToTicks(p, $0) } ?? TickRange(startTick: 0, endTick: .max)
            let ids = try a.argStrs("trackIds").map { Set(try $0.map { try trackOf(p, $0).id }) }
            let all = p.notes.filter { n in
                n.tick < r.endTick && n.tick + n.duration > r.startTick
                    && (ids == nil || ids!.contains(n.trackId))
                    && n.pitch >= (a.argInt("minPitch") ?? 0) && n.pitch <= (a.argInt("maxPitch") ?? 127)
            }
            let off = a.argInt("offset") ?? 0, lim = a.argInt("limit") ?? 200
            return ToolRunOut(data: .object([
                ("total", .int(Int64(all.count))), ("offset", .int(Int64(off))),
                ("notes", .array(all.dropFirst(off).prefix(lim).map { $0.json })),
                ("nextOffset", off + lim < all.count ? .int(Int64(off + lim)) : .null),
            ]))
        },
        GBKTool(name: "gbk_get_cc_events", description: "Timed CC events in a range plus the effective value of each controller at the range start.", inputSchema: schemaObj([
            ("range", rangeSchema), ("trackId", schemaStr()), ("controller", schemaInt(0, 127)), ("limit", schemaInt(1, 2000)),
        ], required: ["trackId"]), readOnly: true) { a in
            let p = P()
            let t = try trackOf(p, a.argStr("trackId")!)
            let r = try a.argObj("range").flatMap(rangeArg).map { try rangeToTicks(p, $0) } ?? TickRange(startTick: 0, endTick: .max)
            let evs = p.ccs.filter { $0.trackId == t.id && (a.argInt("controller") == nil || $0.controller == a.argInt("controller")) }
            var eff: [(String, JSONValue)] = []
            for e in evs where e.tick <= r.startTick {
                let k = "ch\(e.channel + 1)_cc\(e.controller)"
                if let i = eff.firstIndex(where: { $0.0 == k }) { eff[i].1 = .int(Int64(e.value)) } else { eff.append((k, .int(Int64(e.value)))) }
            }
            let inR = evs.filter { $0.tick >= r.startTick && $0.tick < r.endTick }
            return ToolRunOut(data: .object([
                ("effectiveAtStart", .object(eff)), ("mixDefaults", mixJSON(t.mix)),
                ("total", .int(Int64(inR.count))),
                ("events", .array(inR.prefix(a.argInt("limit") ?? 500).map { $0.json })),
            ]))
        },
        GBKTool(name: "gbk_get_selection", description: "Current selection and loop (shared with the UI).", inputSchema: schemaObj([]), readOnly: true) { _ in
            let p = P()
            return ToolRunOut(data: .object([
                ("selection", .object([
                    ("trackIds", .array(p.selection.trackIds.map { .string($0) })),
                    ("startTick", .int(Int64(p.selection.startTick))), ("endTick", .int(Int64(p.selection.endTick))),
                    ("noteIds", .array(p.selection.noteIds.map { .string($0) })),
                ])),
                ("loop", .object([
                    ("enabled", .bool(p.loop.enabled)),
                    ("startTick", .int(Int64(p.loop.startTick))), ("endTick", .int(Int64(p.loop.endTick))),
                ])),
            ]))
        },
        GBKTool(name: "gbk_get_transport", description: "Playback state and position (ticks, seconds, bar/beat).", inputSchema: schemaObj([]), readOnly: true) { _ in
            let p = P(); let t = store.transport
            let bb = tickToBarBeat(p, t.positionTick)
            var pairs: [(String, JSONValue)] = [
                ("playing", .bool(t.playing)), ("positionTick", .int(Int64(t.positionTick))),
                ("audioReady", .bool(t.audioReady)), ("starting", .bool(t.starting)),
                ("sf2Progress", t.sf2Progress.map { .number($0) } ?? .null),
                ("positionSec", jsonFixed3(tickToSec(p, t.positionTick))),
                ("bar", .int(Int64(bb.bar))), ("beat", .number(bb.beat)),
            ]
            return ToolRunOut(data: .object(pairs))
        },
        GBKTool(name: "gbk_list_presets", description: "SoundFont presets available for gbk_set_instrument.", inputSchema: schemaObj([
            ("query", schemaStr()), ("limit", schemaInt(1, 500)),
        ]), readOnly: true) { a in
            await store.host.ensureSoundFont?()
            let all = store.host.listPresets?() ?? []
            let q = (a.argStr("query") ?? "").lowercased()
            let filtered = all.filter { q.isEmpty || ($0["name"]?.stringValue ?? "").lowercased().contains(q) }
            return ToolRunOut(data: .array(Array(filtered.prefix(a.argInt("limit") ?? 200))), warnings: all.isEmpty ? ["no SoundFont loaded"] : [])
        },
        GBKTool(name: "gbk_set_transport", description: "play | pause | stop | seek | loop. Audio may require a user click first (AUDIO_NOT_READY).", inputSchema: schemaObj([
            ("action", schemaEnum(["play", "pause", "stop", "seek", "loop"])),
            ("position", schemaObj([("unit", unitSchema), ("value", .object([("type", .string("number")), ("minimum", .int(0))]))], required: ["unit", "value"])),
            ("loopRange", rangeSchema),
            ("loopEnabled", schemaBool()),
        ], required: ["action"]), readOnly: false) { a in
            let p = P()
            if let pos = a.argObj("position"), let unit = pos.argStr("unit"), let value = pos.argDbl("value") {
                store.seek(try toTick(p, unit: unit, value: value))
            }
            switch a.argStr("action") {
            case "play": try await store.playFromTool()
            case "pause": store.pause()
            case "stop": store.stop()
            case "seek":
                if a.argObj("position") == nil { throw ToolArgError("INVALID_ARGUMENT", "seek needs position") }
            case "loop":
                let r = try a.argObj("loopRange").flatMap(rangeArg).map { try rangeToTicks(p, $0) } ?? TickRange(startTick: p.loop.startTick, endTick: p.loop.endTick)
                let enabled = a.argBool("loopEnabled") ?? true
                store.setLoop { $0.startTick = r.startTick; $0.endTick = r.endTick; $0.enabled = enabled }
            default: break
            }
            return ToolRunOut(data: transportJSON(store))
        },
        GBKTool(name: "gbk_set_track_mix", description: "Set track mix. mode=default edits the persisted mix (undoable; volume is a post-engine fader (v/100)^2 applied live and in renders, on top of authored CC7; pan/expression are the base layer under authored CC automation); mode=override is a temporary live override (not saved); mode=clear_override removes it. Never rewrites authored CC events.", inputSchema: schemaObj([
            ("trackId", schemaStr()), ("mode", schemaEnum(["default", "override", "clear_override"])),
            ("volume", schemaInt(0, 127)), ("pan", schemaInt(0, 127, "0=left 64=center 127=right")), ("expression", schemaInt(0, 127)),
            ("mute", schemaBool()), ("solo", schemaBool()), ("baseRevision", baseRevSchema),
        ], required: ["trackId"]), readOnly: false) { a in
            let t = try trackOf(P(), a.argStr("trackId")!)
            var patch = TrackPatch()
            patch.volume = a.argInt("volume"); patch.pan = a.argInt("pan"); patch.expression = a.argInt("expression")
            patch.mute = a.argBool("mute"); patch.solo = a.argBool("solo")
            let mode = a.argStr("mode") ?? "default"
            if mode == "clear_override" {
                store.setOverride(t.id, mix: nil)
                return ToolRunOut(data: .object([("cleared", .string(t.id))]))
            }
            if mode == "override" {
                store.setOverride(t.id, mix: patch)
                return ToolRunOut(data: .object([("override", overrideJSON(store.overrides[t.id]))]))
            }
            let r = try store.setTrackMixDefault(t.id, patch: patch, source: "agent", baseRevision: a.argInt("baseRevision"))
            let authored = P().ccs.contains { $0.trackId == t.id && [7, 10, 11].contains($0.controller) }
            return ToolRunOut(data: .object([("mix", mixJSON(try trackOf(P(), t.id).mix))]),
                              warnings: r.warnings + (authored ? ["track has authored CC7/10/11 automation which overrides the mix default at its event times"] : []))
        },
        GBKTool(name: "gbk_set_instrument", description: "Set a track's program/bank at tick 0 (undoable).", inputSchema: schemaObj([
            ("trackId", schemaStr()), ("program", schemaInt(0, 127)), ("bankMsb", schemaInt(0, 127)), ("bankLsb", schemaInt(0, 127)), ("baseRevision", baseRevSchema),
        ], required: ["trackId", "program"]), readOnly: false) { a in
            let t = try trackOf(P(), a.argStr("trackId")!)
            let r = try store.edit([.setProgram(trackId: t.id, program: a.argInt("program")!, bankMsb: a.argInt("bankMsb") ?? 0, bankLsb: a.argInt("bankLsb") ?? 0, tick: 0)],
                                   baseRevision: a.argInt("baseRevision"), source: "agent")
            return ToolRunOut(data: .object([("revision", .int(Int64(r.revision)))]), warnings: r.warnings)
        },
        GBKTool(name: "gbk_select_passage", description: "Select a range (and optionally tracks) in the shared UI selection. Does not change the revision.", inputSchema: schemaObj([
            ("range", rangeSchema), ("trackIds", schemaArray(items: schemaStr(), maxItems: 64)),
        ], required: ["range"]), readOnly: false) { a in
            let p = P()
            let r = try rangeToTicks(p, rangeArg(a.argObj("range"))!)
            let ids = try (a.argStrs("trackIds") ?? []).map { try trackOf(p, $0).id }
            let noteIds = p.notes.filter { $0.tick >= r.startTick && $0.tick < r.endTick && (ids.isEmpty || ids.contains($0.trackId)) }.map { $0.id }
            store.setSelection { $0.startTick = r.startTick; $0.endTick = r.endTick; $0.trackIds = ids; $0.noteIds = noteIds }
            return ToolRunOut(data: .object([
                ("startTick", .int(Int64(r.startTick))), ("endTick", .int(Int64(r.endTick))),
                ("trackIds", .array(ids.map { .string($0) })), ("noteCount", .int(Int64(noteIds.count))),
            ]))
        },
        GBKTool(name: "gbk_propose_note_patch", description: "Stage note additions/removals/updates as a proposal (no mutation until committed).", inputSchema: schemaObj([
            ("add", schemaArray(items: noteSchema, maxItems: 2000)),
            ("remove", schemaArray(items: schemaStr(), maxItems: 2000)),
            ("update", schemaArray(items: schemaObj([
                ("id", schemaStr()), ("tick", schemaInt(0, 1_000_000_000)), ("duration", schemaInt(1, 1_000_000_000)),
                ("pitch", schemaInt(0, 127)), ("velocity", schemaInt(1, 127)),
            ], required: ["id"]), maxItems: 2000)),
            ("summary", schemaStr()), ("baseRevision", baseRevSchema),
        ]), readOnly: false) { a in
            let p = P()
            var ops: [ProjectOp] = []
            if let add = a.argArr("add") {
                ops.append(.addNotes(try add.map { n in
                    let t = try trackOf(p, n.argStr("trackId")!)
                    return GNote(id: newStudioId("note"), trackId: t.id, channel: n.argInt("channel") ?? t.channel,
                                 tick: n.argInt("tick")!, duration: n.argInt("duration")!, pitch: n.argInt("pitch")!,
                                 velocity: n.argInt("velocity")!, offVelocity: nil)
                }))
            }
            if let remove = a.argStrs("remove") { ops.append(.removeNotes(Set(remove))) }
            if let update = a.argArr("update") {
                ops.append(.updateNotes(update.map { u in
                    (id: u.argStr("id")!, patch: NotePatch(trackId: nil, channel: nil, tick: u.argInt("tick"), duration: u.argInt("duration"),
                                                           pitch: u.argInt("pitch"), velocity: u.argInt("velocity"), offVelocity: nil))
                }))
            }
            let pr = try store.propose(ops, baseRevision: a.argInt("baseRevision"), source: "agent", summary: a.argStr("summary"))
            return ToolRunOut(data: proposalViewJSON(pr), warnings: pr.warnings)
        },
        GBKTool(name: "gbk_propose_cc_patch", description: "Stage explicit CC points for one track/controller in a range (replace or merge).", inputSchema: schemaObj([
            ("trackId", schemaStr()), ("controller", schemaInt(0, 127)), ("channel", schemaInt(0, 15)),
            ("range", rangeSchema), ("mode", schemaEnum(["replace", "merge"])),
            ("points", schemaArray(items: schemaObj([("tick", schemaInt(0, 1_000_000_000)), ("value", schemaInt(0, 127))], required: ["tick", "value"]), maxItems: 4000)),
            ("summary", schemaStr()), ("baseRevision", baseRevSchema),
        ], required: ["trackId", "controller", "range", "points"]), readOnly: false) { a in
            let p = P()
            let t = try trackOf(p, a.argStr("trackId")!)
            let r = try rangeToTicks(p, rangeArg(a.argObj("range"))!)
            let channel = a.argInt("channel") ?? t.channel
            let points = (a.argArr("points") ?? []).map {
                CCEvent(id: newStudioId("cc"), trackId: t.id, channel: channel, controller: a.argInt("controller")!, tick: $0.argInt("tick")!, value: $0.argInt("value")!)
            }
            let ops = setCCOps(trackId: t.id, channel: channel, controller: a.argInt("controller")!, range: r, mode: a.argStr("mode") ?? "replace", points: points)
            let pr = try store.propose(ops, baseRevision: a.argInt("baseRevision"), source: "agent", summary: a.argStr("summary"))
            return ToolRunOut(data: proposalViewJSON(pr), warnings: pr.warnings + ccWarn(a.argInt("controller")!))
        },
        GBKTool(name: "gbk_generate_cc_curve", description: "Generate a deterministic CC curve (crescendo, decrescendo, swell, linear, smoothstep, exponential, points) over a range for one or more tracks and stage it as a proposal.", inputSchema: schemaObj([
            ("trackIds", schemaArray(items: schemaStr(), maxItems: 64, minItems: 1)),
            ("controller", schemaInt(0, 127)), ("range", rangeSchema),
            ("shape", schemaEnum(["crescendo", "decrescendo", "swell", "linear", "smoothstep", "exponential", "points"])),
            ("from", schemaInt(0, 127)), ("to", schemaInt(0, 127)), ("peak", schemaInt(0, 127)),
            ("exponent", schemaNum(0.1, 20)),
            ("points", schemaArray(items: schemaObj([("beatOffset", .object([("type", .string("number")), ("minimum", .int(0))])), ("value", schemaInt(0, 127))], required: ["beatOffset", "value"]), maxItems: 256)),
            ("density", schemaObj([("unit", schemaEnum(["ticks", "beats"])), ("step", .object([("type", .string("number")), ("minimum", .double(0.001))]))], required: ["unit", "step"])),
            ("simplify", schemaBool()), ("mode", schemaEnum(["replace", "merge"])),
            ("summary", schemaStr()), ("baseRevision", baseRevSchema),
        ], required: ["trackIds", "controller", "range", "shape"]), readOnly: false) { a in
            let p = P()
            let r = try rangeToTicks(p, rangeArg(a.argObj("range"))!)
            let d = a.argObj("density")
            let stepTicks = d.map { dd -> Int in
                let step = dd.argDbl("step")!
                return max(1, Int((dd.argStr("unit") == "beats" ? step * Double(p.ppq) : step).rounded()))
            }
            var spec = CurveSpec(shape: a.argStr("shape")!, startTick: r.startTick, endTick: r.endTick)
            spec.from = a.argInt("from").map(Double.init); spec.to = a.argInt("to").map(Double.init)
            spec.peak = a.argInt("peak").map(Double.init); spec.exponent = a.argDbl("exponent")
            spec.stepTicks = stepTicks; spec.simplify = a.argBool("simplify")
            spec.points = (a.argArr("points") ?? []).map { (tick: r.startTick + Int(($0.argDbl("beatOffset")! * Double(p.ppq)).rounded()), value: Double($0.argInt("value")!)) }
            let pts = try generateCurve(spec, ppq: p.ppq)
            let ops: [ProjectOp] = try (a.argStrs("trackIds") ?? []).flatMap { id -> [ProjectOp] in
                let t = try trackOf(p, id)
                let points = pts.map { CCEvent(id: newStudioId("cc"), trackId: t.id, channel: t.channel, controller: a.argInt("controller")!, tick: $0.tick, value: $0.value) }
                return setCCOps(trackId: t.id, channel: t.channel, controller: a.argInt("controller")!, range: r, mode: a.argStr("mode") ?? "replace", points: points)
            }
            let pr = try store.propose(ops, baseRevision: a.argInt("baseRevision"), source: "agent", summary: a.argStr("summary") ?? "\(a.argStr("shape")!) CC\(a.argInt("controller")!)")
            var data = proposalViewJSON(pr)
            if case .object(var pairs) = data {
                pairs.append(("points", .int(Int64(pts.count))))
                if let first = pts.first { pairs.append(("first", .object([("tick", .int(Int64(first.tick))), ("value", .int(Int64(first.value)))]))) }
                if let last = pts.last { pairs.append(("last", .object([("tick", .int(Int64(last.tick))), ("value", .int(Int64(last.value)))]))) }
                data = .object(pairs)
            }
            return ToolRunOut(data: data, warnings: pr.warnings + ccWarn(a.argInt("controller")!))
        },
        GBKTool(name: "gbk_propose_track_patch", description: "Stage track property changes (name, channel, visibility, mix defaults) or add a track.", inputSchema: schemaObj([
            ("updates", schemaArray(items: schemaObj([
                ("trackId", schemaStr()), ("name", schemaStr()), ("channel", schemaInt(0, 15)), ("visible", schemaBool()),
                ("volume", schemaInt(0, 127)), ("pan", schemaInt(0, 127)), ("expression", schemaInt(0, 127)),
            ], required: ["trackId"]), maxItems: 64)),
            ("addTracks", schemaArray(items: schemaObj([("name", schemaStr()), ("channel", schemaInt(0, 15))], required: ["name", "channel"]), maxItems: 16)),
            ("summary", schemaStr()), ("baseRevision", baseRevSchema),
        ]), readOnly: false) { a in
            let p = P()
            var ops: [ProjectOp] = []
            for u in a.argArr("updates") ?? [] {
                let t = try trackOf(p, u.argStr("trackId")!)
                var patch = TrackPatch()
                patch.name = u.argStr("name"); patch.channel = u.argInt("channel"); patch.visible = u.argBool("visible")
                patch.volume = u.argInt("volume"); patch.pan = u.argInt("pan"); patch.expression = u.argInt("expression")
                ops.append(.updateTrack(id: t.id, patch: patch))
            }
            var added = 0
            for t in a.argArr("addTracks") ?? [] {
                let color = trackColors[(p.tracks.count + added) % trackColors.count]
                added += 1
                ops.append(.addTrack(GTrack(id: newStudioId("trk"), name: t.argStr("name")!, channel: t.argInt("channel")!, color: color, mix: TrackMix(), visible: true, role: nil), index: nil))
            }
            let pr = try store.propose(ops, baseRevision: a.argInt("baseRevision"), source: "agent", summary: a.argStr("summary"))
            return ToolRunOut(data: proposalViewJSON(pr), warnings: pr.warnings)
        },
        GBKTool(name: "gbk_preview_proposal", description: "Audition A (original) or B (candidate) over the proposal range without mutating the project. Bounded to 30 s; honors cancellation.", inputSchema: schemaObj([
            ("proposalId", schemaStr()), ("variant", schemaEnum(["A", "B"])),
        ], required: ["proposalId", "variant"]), readOnly: true) { a in
            try await store.previewProposal(a.argStr("proposalId")!, variant: a.argStr("variant")!)
            return ToolRunOut(data: .object([("previewed", .string(a.argStr("variant")!))]))
        },
        GBKTool(name: "gbk_commit_proposal", description: "Request to apply a proposal as one undoable transaction. The user must press Accept in GBK; returns USER_APPROVAL_REQUIRED if declined.", inputSchema: schemaObj([
            ("proposalId", schemaStr()),
        ], required: ["proposalId"]), readOnly: false) { a in
            let revision = try await store.commitProposal(a.argStr("proposalId")!, source: "agent")
            return ToolRunOut(data: .object([("revision", .int(Int64(revision)))]))
        },
        GBKTool(name: "gbk_discard_proposal", description: "Discard a pending proposal (project unchanged).", inputSchema: schemaObj([
            ("proposalId", schemaStr()),
        ], required: ["proposalId"]), readOnly: false) { a in
            try store.discardProposal(a.argStr("proposalId")!, source: "agent")
            return ToolRunOut(data: .object([("discarded", .string(a.argStr("proposalId")!))]))
        },
        GBKTool(name: "gbk_undo", description: "Undo the agent's own last edit. The history is shared with the user: if the newest edit is the user's, this refuses with NOT_AGENT_EDIT instead of reverting their work.", inputSchema: schemaObj([]), readOnly: false) { _ in
            ToolRunOut(data: .object([("undone", .bool(try store.agentUndo()))]))
        },
        GBKTool(name: "gbk_redo", description: "Redo an agent edit previously undone with gbk_undo. Refuses with NOT_AGENT_EDIT when the next redo entry is the user's edit.", inputSchema: schemaObj([]), readOnly: false) { _ in
            ToolRunOut(data: .object([("redone", .bool(try store.agentRedo()))]))
        },
        GBKTool(name: "gbk_prepare_midi_export", description: "Build a Standard MIDI File (tempo/meter, timed CC, bend/pressure, programs, raw events) and offer it as a browser-local download.", inputSchema: schemaObj([
            ("download", schemaBool()),
        ]), readOnly: false) { a in
            let (bytes, filename) = store.prepareMidiExport()
            if a.argBool("download") != false { _ = store.host.download?(bytes, filename) }
            return ToolRunOut(data: .object([
                ("filename", .string(filename)), ("bytes", .int(Int64(bytes.count))),
                ("downloaded", .bool(a.argBool("download") != false && store.host.download != nil)),
            ]))
        },
        GBKTool(name: "gbk_prepare_wav_export", description: "Offline-render the project with the headless SF2 renderer (same engine as gbk_render_wav; no audio unlock needed). Offers a browser download unless download is false (legacy behavior); prefer gbk_render_wav for artifacts and byte transfer.", inputSchema: schemaObj([
            ("download", schemaBool()),
            ("normalize", schemaEnum(["loudness", "peak", "off"], "whole-file level (default loudness: -16 LUFS, <= -1 dBTP)")),
        ]), readOnly: false) { a in
            guard let renderWav = store.host.renderWav else { throw ToolArgError("UNSUPPORTED", "no renderer in this runtime") }
            let blob = try await renderWav(store.project, a.argStr("normalize") ?? "loudness")
            try checkCancelled()
            let safe = String(store.project.name.unicodeScalars.map { scalar -> Character in
                let v = scalar.value
                let ok = (v >= 48 && v <= 57) || (v >= 65 && v <= 90) || (v >= 97 && v <= 122) || v == 95 || v == 45 || v == 32 || v == 46
                return ok ? Character(scalar) : "_"
            }.prefix(80))
            let filename = "\(safe.isEmpty ? "gbk" : safe).wav"
            let requested = a.argBool("download") != false && store.host.download != nil && store.host.download!(blob, filename) != false
            return ToolRunOut(data: .object([
                ("filename", .string(filename)), ("bytes", .int(Int64(blob.count))), ("downloadRequested", .bool(requested)),
            ]))
        },
    ]
}
