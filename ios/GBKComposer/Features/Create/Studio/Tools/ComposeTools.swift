import Foundation

// Port of buildComposeTools in src/webmcp/compose-tools.ts.

let trackInputSchema = schemaObj([
    ("name", schemaStr(nil, maxLength: 64)),
    ("channel", schemaInt(0, 15, "0-based MIDI channel; 9 = GM percussion (channel 10). Omit to auto-assign a free channel.")),
    ("program", schemaInt(0, 127)), ("bankMsb", schemaInt(0, 127)), ("bankLsb", schemaInt(0, 127)),
    ("role", schemaEnum(trackRoles)),
    ("volume", schemaInt(0, 127)), ("pan", schemaInt(0, 127, "0=left 64=center 127=right")), ("expression", schemaInt(0, 127)),
    ("id", schemaStr("optional stable id", maxLength: 64)),
], required: ["name"])

func buildComposeTools(_ store: WorkstationStore) -> [GBKTool] {
    let P = { store.project }
    return [
        GBKTool(name: "gbk_create_project", description: "Create a new, empty composition project (no Player / Library needed) and start a scoped autonomous session: later gbk_* edits to THIS project apply without per-change approval (still undoable; the user can end the session or discard the work). The current project is checkpointed to browser storage first unless replaceCurrent is true. Existing user projects keep Accept approval.", inputSchema: schemaObj([
            ("name", schemaStr(nil, maxLength: 128)),
            ("tempo", schemaNum(10, 400, "BPM")),
            ("timeSignature", .object([
                ("type", .string("array")),
                ("items", .object([("type", .string("integer")), ("minimum", .int(1)), ("maximum", .int(32))])),
                ("minItems", .int(2)), ("maxItems", .int(2)),
                ("description", .string("[numerator, denominator]")),
            ])),
            ("key", schemaStr("e.g. \"C minor\"", maxLength: 32)),
            ("ppq", schemaInt(24, 32767)),
            ("replaceCurrent", schemaBool()),
            ("descriptors", .object([("type", .string("object")), ("description", .string("free-form string metadata (mood, form, ...)"))])),
        ], required: ["name"]), readOnly: false) { a in
            if let key = a.argStr("key") { _ = try parseKeyInfo(key) }
            var descriptors: [String: String]? = nil
            if let d = a.argObj("descriptors") {
                guard case .object(let pairs) = d, pairs.count <= 32, pairs.allSatisfy({ $0.1.stringValue != nil }) else {
                    throw ToolArgError("INVALID_ARGUMENT", "descriptors must be <= 32 string values")
                }
                descriptors = Dictionary(uniqueKeysWithValues: pairs.map { ($0.0, $0.1.stringValue!) })
            }
            let ts = a.argArr("timeSignature").map { ($0[0].intValue!, $0[1].intValue!) }
            let r = try await store.createProject(CreateProjectOptions(
                name: a.argStr("name")!, tempo: a.argDbl("tempo"), timeSignature: ts, key: a.argStr("key"),
                ppq: a.argInt("ppq"), replaceCurrent: a.argBool("replaceCurrent") ?? false, owner: "agent", descriptors: descriptors))
            return ToolRunOut(data: jsonObj([
                ("projectId", .string(r.project.id)), ("revision", .int(Int64(r.project.revision))),
                ("ppq", .int(Int64(r.project.ppq))),
                ("tempos", .array(r.project.tempos.map { $0.json })), ("timeSigs", .array(r.project.timeSigs.map { $0.json })),
                ("key", r.project.meta?.key.map { .string($0) } ?? .null),
                ("previousProjectId", .string(r.previousProjectId)), ("previousCheckpointed", .bool(r.checkpointed)),
                ("session", sessionJSON(r.session)),
            ]))
        },
        GBKTool(name: "gbk_create_track", description: "Create one track, or several atomically via `tracks`, with bank/program, role, and mix defaults (volume CC7, pan CC10, expression CC11). Channels are auto-assigned without collisions (percussion -> channel 10). Returns the track ids. Program/bank are checked against the SoundFont (substitution warnings).", inputSchema: schemaObj(
            (trackInputSchema["properties"]?.objectValue ?? []) + [
                ("tracks", schemaArray(items: trackInputSchema, maxItems: 16, minItems: 1)),
                ("baseRevision", schemaInt(0, 9007199254740991)),
            ], required: []), readOnly: false) { a in
            var list: [TrackInput] = []
            if let tracks = a.argArr("tracks") {
                if a.argStr("name") != nil { throw ToolArgError("INVALID_ARGUMENT", "pass either a single track or tracks, not both") }
                list = tracks.map(trackInputFromJSON)
            } else if a.argStr("name") != nil {
                list = [trackInputFromJSON(a)]
            }
            if list.isEmpty { throw ToolArgError("INVALID_ARGUMENT", "pass name (one track) or tracks (batch)") }
            let (ops, ids, warnings) = try trackOps(store, P(), list)
            let channels: [Int] = ops.compactMap { op in if case .addTrack(let t, _) = op { return t.channel }; return nil }
            let extra: [(String, JSONValue)] = [
                ("trackIds", .array(ids.map { .string($0) })),
                ("tracks", .array(list.enumerated().map { (i, t) in
                    .object([("id", .string(ids[i])), ("name", .string(t.name)), ("channel", .int(Int64(channels[i]))), ("program", .int(Int64(t.program ?? 0)))])
                })),
            ]
            let r = try appliedResult(store, ops, label: "create \(ids.count) track(s)", baseRevision: a.argInt("baseRevision"), extra: extra)
            return ToolRunOut(data: r.data, warnings: warnings + r.warnings)
        },
        GBKTool(name: "gbk_set_tempo_map", description: "Replace the tempo map. events: [{bar (1-based), beat? (0-based beat within the bar), bpm}], first at bar 1. Bars follow the current meter map (set the meter first when it changes). Affects playback, MIDI export and offline WAV timing.", inputSchema: schemaObj([
            ("events", schemaArray(items: schemaObj([
                ("bar", schemaInt(1, 100000)), ("beat", schemaNum(0, 64)), ("bpm", schemaNum(10, 400)),
            ], required: ["bar", "bpm"]), maxItems: 1024, minItems: 1)),
            ("baseRevision", schemaInt(0, 9007199254740991)),
        ], required: ["events"]), readOnly: false) { a in
            let p = P()
            let evs = (a.argArr("events") ?? []).map { e in
                TempoEvent(tick: barBeatToTick(p, bar: e.argInt("bar")!, beat: e.argDbl("beat") ?? 0),
                           microPerQuarter: Int((60_000_000.0 / e.argDbl("bpm")!).rounded()))
            }.sorted { $0.tick < $1.tick }
            let end = p.endTick
            let r = try appliedResult(store, [.setTempoMap(evs)], label: "tempo map (\(evs.count))", baseRevision: a.argInt("baseRevision"),
                                      extra: [("events", .array(evs.map { $0.json }))])
            var data = r.data
            if case .object(var pairs) = data {
                pairs.append(("durationSec", jsonFixed3(tickToSec(store.project, end))))
                data = .object(pairs)
            }
            return ToolRunOut(data: data, warnings: r.warnings)
        },
        GBKTool(name: "gbk_set_time_signature_map", description: "Replace the meter map: events [{bar, numerator, denominator}] (first at bar 1), e.g. 4/4, 3/4, 6/8, 2/2. Changes land on bar boundaries computed under the new map. Existing notes keep their ticks.", inputSchema: schemaObj([
            ("events", schemaArray(items: schemaObj([
                ("bar", schemaInt(1, 100000)), ("numerator", schemaInt(1, 32)),
                ("denominator", .object([("type", .string("integer")), ("enum", .array([1, 2, 4, 8, 16, 32].map { .int(Int64($0)) }))])),
            ], required: ["bar", "numerator", "denominator"]), maxItems: 1024, minItems: 1)),
            ("baseRevision", schemaInt(0, 9007199254740991)),
        ], required: ["events"]), readOnly: false) { a in
            let p = P()
            let src = (a.argArr("events") ?? []).map { (bar: $0.argInt("bar")!, numerator: $0.argInt("numerator")!, denominator: $0.argInt("denominator")!) }
                .sorted { $0.bar < $1.bar }
            guard let first = src.first, first.bar == 1 else { throw ToolArgError("INVALID_ARGUMENT", "the first meter event must be at bar 1") }
            var evs: [TimeSigEvent] = []
            var tick = 0.0, bar = 1, len = 0.0
            for e in src {
                if e.bar == bar && !evs.isEmpty { throw ToolArgError("INVALID_ARGUMENT", "two meter events at bar \(e.bar)") }
                tick += Double(e.bar - bar) * len
                bar = e.bar
                len = (Double(p.ppq) * 4 / Double(e.denominator)) * Double(e.numerator)
                evs.append(TimeSigEvent(tick: Int(tick.rounded()), numerator: e.numerator, denominator: e.denominator))
            }
            let warnings = p.notes.isEmpty ? [] : ["existing notes keep their tick positions; bar numbers after a meter change shift accordingly"]
            let r = try appliedResult(store, [.setTimeSigMap(evs)], label: "meter map (\(evs.count))", baseRevision: a.argInt("baseRevision"),
                                      extra: [("events", .array(evs.map { $0.json }))])
            return ToolRunOut(data: r.data, warnings: warnings + r.warnings)
        },
        GBKTool(name: "gbk_set_song_structure", description: "Set the semantic arrangement plan: sections [{name, startBar, bars, energy 0..1}] (non-overlapping). Persisted with the project, drawn as markers in the piano roll/transport, exported as MIDI markers, and used by gbk_generate_arrangement for dynamics.", inputSchema: schemaObj([
            ("sections", schemaArray(items: schemaObj([
                ("name", schemaStr(nil, maxLength: 64)), ("startBar", schemaInt(1, 100000)), ("bars", schemaInt(1, 100000)), ("energy", schemaNum(0, 1)),
            ], required: ["name", "startBar", "bars"]), maxItems: 256)),
            ("baseRevision", schemaInt(0, 9007199254740991)),
        ], required: ["sections"]), readOnly: false) { a in
            let secs = (a.argArr("sections") ?? []).map {
                Section(name: $0.argStr("name")!, startBar: $0.argInt("startBar")!, bars: $0.argInt("bars")!, energy: $0.argDbl("energy"))
            }
            let r = try appliedResult(store, [.setSections(secs)], label: "song structure (\(secs.count) sections)", baseRevision: a.argInt("baseRevision"))
            let p = store.project
            var data = r.data
            if case .object(var pairs) = data {
                pairs.append(("sections", .array(secs.map { s in
                    .object([("name", .string(s.name)),
                             ("startTick", .int(Int64(barBeatToTick(p, bar: s.startBar)))),
                             ("endTick", .int(Int64(barBeatToTick(p, bar: s.startBar + s.bars))))])
                })))
                pairs.append(("totalBars", .int(Int64(max(0, secs.map { $0.startBar + $0.bars - 1 }.max() ?? 0)))))
                data = .object(pairs)
            }
            return ToolRunOut(data: data, warnings: r.warnings)
        },
        GBKTool(name: "gbk_get_composition_session", description: "The autonomous session (if any): which project it covers, expiry, and whether edits on the current project apply without approval.", inputSchema: schemaObj([]), readOnly: true) { _ in
            let p = P()
            return ToolRunOut(data: jsonObj([
                ("session", sessionJSON(store.currentSession())),
                ("currentProjectId", .string(p.id)),
                ("owner", .string(p.meta?.owner ?? "user")),
                ("autonomousEditsAllowed", .bool(store.autonomousAllowed())),
                ("bars", .int(Int64(bars(p, upToTick: p.endTick).count))),
                ("sections", .array((p.meta?.sections ?? []).map { $0.json })),
                ("key", p.meta?.key.map { .string($0) } ?? .null),
            ]))
        },
    ]
}
