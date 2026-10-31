import Foundation

// Port of buildArrangementTools in src/webmcp/arrangement-tools.ts.

private let defaultInstr: [String: [String]] = [
    "baroque": ["violin", "viola", "cello", "harpsichord"],
    "classical": ["flute", "violin", "cello", "piano"],
    "pop": ["piano", "bass", "strings", "drums"],
    "jazz": ["trumpet", "piano", "bass", "drums"],
    "ambient": ["strings", "choir", "piano"],
]

private let scaleSteps: [String: [Int]] = ["major": [0, 2, 4, 5, 7, 9, 11], "minor": [0, 2, 3, 5, 7, 8, 10]]

/// Per-pitch-class offsets (relative to the source tonic) re-voicing the source scale as the target.
func degreeMap(_ sourceMode: String, _ targetMode: String) -> [Int] {
    let s = scaleSteps[sourceMode]!, t = scaleSteps[targetMode]!
    var m = [Int](repeating: 0, count: 12)
    for (i, pc) in s.enumerated() { m[pc] = t[i] - pc }
    return m
}

private func isPercussionTrack(_ t: GTrack) -> Bool { t.channel == 9 || t.role == "percussion" }

private func gridFor(_ p: Project, _ startTick: Int, _ endTick: Int) -> [BarGrid] {
    let n = min(100000, Int(ceil(Double(endTick) / Double(p.ppq))) + 2)
    return arrangementBarGrid(p, n).filter { $0.tick >= startTick && $0.tick < endTick }
}

/// transform:"remap" (#162 step 4): a degree-aware key change as ONE op batch.
private func remapNotes(_ store: WorkstationStore, _ p: Project, _ a: JSONValue, _ r: TickRange) throws -> ToolRunOut {
    let srcKey = try keyOf(p, nil)
    var semi = a.argInt("semitones") ?? 0
    var map = a.argInts("pitchClassMap")
    if let map, map.count != 12 {
        throw ToolArgError("INVALID_ARGUMENT", "pitchClassMap needs exactly 12 entries (one per pitch class, relative to the source tonic)")
    }
    var targetLabel: String? = nil
    if let targetKey = a.argStr("targetKey") {
        let tk = try parseKeyInfo(targetKey)
        let d = ((tk.tonic - srcKey.tonic) % 12 + 12) % 12
        semi = d > 6 ? d - 12 : d // prefer the short way round so registers survive
        if map == nil { map = degreeMap(srcKey.mode, tk.mode) }
        targetLabel = tk.label
    }
    guard let map else { throw ToolArgError("INVALID_ARGUMENT", "remap needs targetKey or pitchClassMap") }
    let targets = a.argStr("trackId") == "*" ? p.tracks : [try trackOf(p, a.argStr("trackId")!)]
    var ops: [ProjectOp] = []
    var skipped: [String] = []
    var changed = 0
    for t in targets {
        if isPercussionTrack(t) { skipped.append(t.name); continue }
        let src = p.notes.filter { $0.trackId == t.id && $0.tick >= r.startTick && $0.tick < r.endTick }
        if src.isEmpty { continue }
        let mapped = src.map { n -> GNote in
            let rel = ((n.pitch - srcKey.tonic) % 12 + 12) % 12
            return GNote(id: newStudioId("note"), trackId: t.id, channel: t.channel, tick: n.tick, duration: n.duration,
                         pitch: max(0, min(127, n.pitch + semi + map[rel])), velocity: n.velocity, offVelocity: nil)
        }
        ops.append(.removeNotes(Set(src.map { $0.id })))
        ops.append(.addNotes(mapped))
        changed += src.count
    }
    if changed == 0 { throw ToolArgError("INVALID_RANGE", "no remappable notes in range (percussion tracks are always skipped)") }
    if let targetLabel {
        var meta = p.meta ?? ProjectMeta()
        meta.key = targetLabel
        ops.append(.setMeta(meta))
    }
    var extra: [(String, JSONValue)] = [("sourceNotes", .int(Int64(changed))), ("resultNotes", .int(Int64(changed))), ("semitones", .int(Int64(semi)))]
    if let targetLabel { extra.append(("key", .string(targetLabel))) }
    let out = try appliedResult(store, ops, label: targetLabel.map { "remap to \($0) (\(changed) notes)" } ?? "remap notes (\(changed) notes)",
                                baseRevision: a.argInt("baseRevision"), extra: extra)
    return ToolRunOut(data: out.data, warnings: out.warnings
        + (skipped.isEmpty ? [] : ["skipped percussion track(s): \(skipped.joined(separator: ", "))"])
        + (targetLabel == nil ? ["meta.key not updated (no targetKey given)"] : []))
}

func buildArrangementTools(_ store: WorkstationStore) -> [GBKTool] {
    let P = { store.project }
    let baseRev = schemaInt(0, 9007199254740991)
    return [
        GBKTool(name: "gbk_generate_arrangement", description: "Generate a complete multi-track arrangement (real notes + CC11 phrase dynamics, CC1 vibrato, CC91 reverb send) from a seeded rule-based strategy: baroque (GBK Bach fugue generator + continuo), classical, pop, jazz, ambient. Creates or reuses tracks for `instrumentation`, sets sections/key/tempo when missing, and applies it as ONE transaction (immediately inside an autonomous session, else as a proposal). Returns a summary (counts, ranges, counterpoint metrics), not the notes.", inputSchema: schemaObj([
            ("style", schemaEnum(["baroque", "classical", "pop", "jazz", "ambient"])),
            ("key", schemaStr(nil, maxLength: 32)),
            ("tempo", schemaNum(10, 400)),
            ("bars", schemaInt(1, 512)),
            ("seed", schemaInt(0, 2147483648)),
            ("voices", .object([("type", .string("integer")), ("enum", .array([.int(3), .int(4)]))])),
            ("complexity", schemaInt(1, 5)),
            ("instrumentation", schemaArray(items: schemaStr(nil, maxLength: 32, extra: [("description", .string("one of violin, viola, cello, contrabass, strings, harpsichord, piano, organ, flute, oboe, clarinet, bassoon, horn, trumpet, guitar, bass, choir, drums or an existing track name"))]), maxItems: 12)),
            ("features", schemaObj([
                ("counterpoint", schemaBool()), ("dynamicExpression", schemaBool()), ("articulation", schemaBool()), ("cadences", schemaBool()),
            ])),
            ("replaceExisting", schemaBool("remove existing notes on the target tracks in the range first (default true)")),
            ("baseRevision", baseRev),
        ], required: ["style"]), readOnly: false) { a in
            let p = P()
            let style = a.argStr("style")!
            let key = try keyOf(p, a.argStr("key"))
            let secs = p.meta?.sections ?? []
            let nBars = a.argInt("bars") ?? (secs.isEmpty ? 32 : (secs.map { $0.startBar + $0.bars - 1 }.max() ?? 32))
            var pre: [ProjectOp] = []
            var warnings: [String] = []
            if let tempo = a.argDbl("tempo") {
                if p.tempos.count <= 1 {
                    pre.append(.setTempoMap([TempoEvent(tick: 0, microPerQuarter: Int((60_000_000.0 / tempo).rounded()))]))
                } else {
                    warnings.append("project has a tempo map; tempo argument ignored (use gbk_set_tempo_map)")
                }
            }
            if a.argStr("key") != nil || p.meta?.key == nil {
                var meta = p.meta ?? ProjectMeta()
                meta.key = key.label; meta.style = style; meta.seed = a.argInt("seed") ?? 1
                pre.append(.setMeta(meta))
            }
            if secs.isEmpty { pre.append(.setSections(defaultSections(nBars))) }
            let names = a.argStrs("instrumentation") ?? defaultInstr[style] ?? defaultInstr["classical"]!
            var assigned: [(trackId: String, spec: InstrumentSpec)] = []
            var create: [(name: String, spec: InstrumentSpec)] = []
            var taken = Set<String>()
            for nm in names {
                let spec = instrumentSpec(nm)
                let ex = p.tracks.first { t in
                    !taken.contains(t.id) && (t.name.lowercased() == nm.lowercased()
                        || t.name.lowercased().contains(spec.name.lowercased())
                        || (p.programs.first { $0.trackId == t.id }?.program == spec.program && spec.family != "drums"))
                }
                if let ex { taken.insert(ex.id); assigned.append((ex.id, spec)) } else { create.append((spec.name, spec)) }
            }
            if !create.isEmpty {
                let t = try trackOps(store, p, create.map {
                    TrackInput(name: $0.name, program: $0.spec.program, role: $0.spec.role, volume: 100, pan: $0.spec.pan, expression: 127)
                })
                pre.append(contentsOf: t.ops)
                warnings.append(contentsOf: t.warnings)
                for (id, c) in zip(t.ids, create) { assigned.append((id, c.spec)) }
            }
            try checkCancelled()
            _ = try validateProjectOps(p, pre)
            let cand = applyProjectOps(p, pre)
            let parts = assigned.map { x in AssignedPart(track: cand.tracks.first { $0.id == x.trackId }!, spec: x.spec) }
            var features = ArrangementFeatures()
            if let f = a.argObj("features") {
                features.counterpoint = f.argBool("counterpoint") ?? true
                features.dynamicExpression = f.argBool("dynamicExpression") ?? true
                features.articulation = f.argBool("articulation") ?? true
                features.cadences = f.argBool("cadences") ?? true
            }
            let plan = ArrangementPlan(style: style, key: key, bars: nBars, seed: a.argInt("seed") ?? 1,
                                       voices: a.argInt("voices") ?? 4, complexity: a.argInt("complexity") ?? 3, features: features)
            let res = try generateArrangement(cand, plan: plan, parts: parts)
            let grid = arrangementBarGrid(cand, nBars)
            let end = grid.isEmpty ? 0 : grid[grid.count - 1].tick + grid[grid.count - 1].length
            var ops = pre
            if a.argBool("replaceExisting") != false {
                let removeIds = p.notes.filter { taken.contains($0.trackId) && $0.tick < end }.map { $0.id }
                if !removeIds.isEmpty { ops.append(.removeNotes(Set(removeIds))) }
            }
            ops.append(contentsOf: res.ops)
            let extra: [(String, JSONValue)] = [
                ("style", .string(style)), ("key", .string(key.label)), ("bars", .int(Int64(nBars))), ("seed", .int(Int64(plan.seed))),
                ("durationSec", .number(res.durationSec)), ("totalNotes", .int(Int64(res.totalNotes))), ("totalCcs", .int(Int64(res.totalCcs))),
                ("tracks", .array(res.perTrack.map { t in
                    jsonObj([("trackId", .string(t.trackId)), ("name", .string(t.name)), ("notes", .int(Int64(t.notes))), ("ccs", .int(Int64(t.ccs))),
                             ("range", t.range.map { .array($0.map { .int(Int64($0)) }) } ?? .null)])
                })),
                ("sections", .array(res.sections.map { $0.json })),
                ("metrics", .object([
                    ("parallels", .int(Int64(res.metrics.parallelPerfects))),
                    ("crossings", .int(Int64(res.metrics.voiceCrossings))),
                    ("ratio", .number(res.metrics.repeatedNoteRatio)),
                ])),
                ("analysis", .array(res.analysis.prefix(12).map { .string($0) })),
            ]
            let out = try appliedResult(store, ops, label: "\(style) arrangement (\(nBars) bars, \(key.label), seed \(plan.seed), \(res.totalNotes) notes)",
                                        baseRevision: a.argInt("baseRevision"), extra: extra)
            return ToolRunOut(data: out.data, warnings: warnings + out.warnings + ["rule-based generator (not a trained model); metrics are heuristic"])
        },
        GBKTool(name: "gbk_generate_part", description: "Generate one part into a track over a range: melody (chord tones + passing tones), bass (roots / root-fifth / walking), chords (block), arpeggio, alberti, drums (GM grid), or counterpoint (against `againstTrackId`). Seeded; uses the project key unless `key` is given; optional explicit `progression` of scale degrees (one per bar).", inputSchema: schemaObj([
            ("trackId", schemaStr()), ("range", rangeSchemaBare),
            ("kind", schemaEnum(["melody", "bass", "walking_bass", "chords", "arpeggio", "alberti", "drums", "counterpoint"])),
            ("seed", schemaInt(0, 2147483648)), ("key", schemaStr(nil, maxLength: 32)),
            ("progression", schemaArray(items: schemaInt(1, 7), maxItems: 512)),
            ("againstTrackId", schemaStr()), ("low", schemaInt(0, 127)), ("high", schemaInt(0, 127)),
            ("velocity", schemaInt(1, 127)), ("baseRevision", baseRev),
        ], required: ["trackId", "range", "kind"]), readOnly: false) { a in
            let p = P()
            let t = try trackOf(p, a.argStr("trackId")!)
            let r = try rangeToTicks(p, rangeArg(a.argObj("range"))!)
            let key = try keyOf(p, a.argStr("key"))
            let rngObj = seededRNG(a.argInt("seed") ?? 1)
            let R: Rand = { rngObj.next() }
            let grid = gridFor(p, r.startTick, r.endTick)
            if grid.isEmpty { throw ToolArgError("INVALID_RANGE", "range contains no bar starts") }
            let prog = a.argInts("progression") ?? chordProgression(bars: grid.count, style: p.meta?.style ?? "classical", r: R)
            let chords = grid.indices.map { prog[$0 % prog.count] }
            let spec = instrumentSpec(t.name)
            let lo = a.argInt("low") ?? spec.lo, hi = a.argInt("high") ?? spec.hi
            var ns: [MNote]
            switch a.argStr("kind") {
            case "melody": ns = composeMelody(grid: grid, chords: chords, key: key, lo: lo, hi: hi, r: R)
            case "bass": ns = composeBassLine(grid: grid, chords: chords, key: key, lo: lo, hi: min(hi, 62), r: R, pattern: "root-fifth")
            case "walking_bass": ns = composeBassLine(grid: grid, chords: chords, key: key, lo: lo, hi: min(hi, 62), r: R, pattern: "walking")
            case "chords": ns = composeAccompaniment(grid: grid, chords: chords, key: key, lo: max(lo, 48), hi: min(hi, 79), r: R, style: "block")
            case "arpeggio": ns = composeAccompaniment(grid: grid, chords: chords, key: key, lo: max(lo, 48), hi: min(hi, 79), r: R, style: "arpeggio")
            case "alberti": ns = composeAccompaniment(grid: grid, chords: chords, key: key, lo: max(lo, 48), hi: min(hi, 79), r: R, style: "alberti")
            case "drums": ns = composeDrumPattern(grid: grid, r: R, style: "pop")
            default:
                guard let againstId = a.argStr("againstTrackId") else { throw ToolArgError("INVALID_ARGUMENT", "counterpoint needs againstTrackId") }
                let cf = try trackOf(p, againstId)
                let cantus = p.notes.filter { $0.trackId == cf.id && $0.tick < r.endTick && $0.tick + $0.duration > r.startTick }
                if cantus.isEmpty { throw ToolArgError("INVALID_RANGE", "againstTrackId has no notes in range") }
                let above = (cantus.reduce(0) { $0 + $1.pitch } / cantus.count) < (lo + hi) / 2
                ns = counterpoint(cantus: mNotes(cantus), CounterpointOpts(
                    lo: lo, hi: hi, rhythm: 2, seed: a.argInt("seed") ?? 1, startTick: r.startTick, endTick: r.endTick,
                    ppq: p.ppq, velocity: nil, tonic: key.tonic, mode: key.mode, above: above)).notes
            }
            ns = ns.filter { $0.tick < r.endTick }.map {
                MNote(tick: $0.tick, duration: max(1, min($0.duration, r.endTick - $0.tick)), pitch: $0.pitch, velocity: a.argInt("velocity") ?? $0.velocity)
            }
            return try appliedResult(store, [.addNotes(ns.map {
                GNote(id: newStudioId("note"), trackId: t.id, channel: t.channel, tick: $0.tick, duration: $0.duration, pitch: $0.pitch, velocity: $0.velocity, offVelocity: nil)
            })], label: "\(a.argStr("kind")!) on \(t.name) (\(ns.count) notes)", baseRevision: a.argInt("baseRevision"),
            extra: [("notes", .int(Int64(ns.count))), ("key", .string(key.label)), ("progression", .array(chords.prefix(32).map { .int(Int64($0)) }))])
        },
        GBKTool(name: "gbk_transform_notes", description: "Transform a track's notes in a range: transpose, invert (around axis pitch), retrograde, repeat / sequence (copies after the range, shifted by `semitones` per copy), quantize (grid in beats, strength), humanize (velocity ± amount, timing ± ticks, seeded), articulation (legato/detache/staccato/tenuto/marcato), phrase_dynamics (velocity arcs per `phraseBars`), variation (ornament/diminution/inversion), remap (degree-aware key change: pass `targetKey` e.g. \"A major\" - resolved against the project key to a transpose + per-degree pitch-class map - or `semitones` + a 12-entry `pitchClassMap` of offsets relative to the source tonic; trackId \"*\" remaps every non-percussion track as ONE change, percussion is always skipped, and meta.key is updated in the same change when targetKey is given).", inputSchema: schemaObj([
            ("trackId", schemaStr()), ("range", rangeSchemaBare),
            ("transform", schemaEnum(["transpose", "invert", "retrograde", "repeat", "sequence", "quantize", "humanize", "articulation", "phrase_dynamics", "variation", "remap"])),
            ("semitones", schemaInt(-48, 48)),
            ("pitchClassMap", schemaArray(items: schemaInt(-2, 2), maxItems: 12, description: "remap only: 12 offsets (-2..+2), one per pitch class relative to the source tonic")),
            ("targetKey", schemaStr(nil, maxLength: 32, extra: [("description", .string("remap only: target key, e.g. \"A major\"; resolved against the project key"))])),
            ("axis", schemaInt(0, 127)), ("times", schemaInt(1, 64)),
            ("grid", schemaNum(0.0625, 4)), ("strength", schemaNum(0, 1)),
            ("amount", schemaInt(0, 64)), ("timing", schemaInt(0, 240)),
            ("articulation", schemaEnum(["legato", "detache", "staccato", "tenuto", "marcato"])),
            ("variation", schemaEnum(["ornament", "diminution", "inversion"])),
            ("phraseBars", schemaInt(1, 64)), ("seed", schemaInt(0, 2147483648)),
            ("includePercussion", schemaBool("#163 #8: pitch-changing transforms on a percussion track remap drum SOUNDS; refused unless this is true")),
            ("baseRevision", baseRev),
        ], required: ["trackId", "range", "transform"]), readOnly: false) { a in
            let p = P()
            let r = try rangeToTicks(p, rangeArg(a.argObj("range"))!)
            if a.argStr("transform") == "remap" { return try remapNotes(store, p, a, r) }
            let t = try trackOf(p, a.argStr("trackId")!)
            let pitchTransforms: Set<String> = ["transpose", "invert", "sequence", "variation"]
            if pitchTransforms.contains(a.argStr("transform")!) && isPercussionTrack(t) && a.argBool("includePercussion") != true {
                throw ToolArgError("PERCUSSION_PITCH_GUARD", "\(a.argStr("transform")!) on percussion track \"\(t.name)\" would remap drum sounds (pitch selects the drum on channel 9); pass includePercussion:true only if that is really intended")
            }
            let src = p.notes.filter { $0.trackId == t.id && $0.tick >= r.startTick && $0.tick < r.endTick }
            if src.isEmpty { throw ToolArgError("INVALID_RANGE", "no notes of that track in range") }
            let rngObj = seededRNG(a.argInt("seed") ?? 1)
            let R: Rand = { rngObj.next() }
            let span = r.endTick - r.startTick
            var out: [MNote]
            var keep = false
            switch a.argStr("transform") {
            case "transpose": out = transposeNotes(mNotes(src), a.argInt("semitones") ?? 12)
            case "invert": out = invertNotes(mNotes(src), axis: a.argInt("axis") ?? src[0].pitch)
            case "retrograde": out = retrogradeNotes(mNotes(src))
            case "repeat": out = sequenceNotes(mNotes(src), times: (a.argInt("times") ?? 1) + 1, tickOffset: span, semis: 0).filter { $0.tick >= r.endTick }; keep = true
            case "sequence": out = sequenceNotes(mNotes(src), times: (a.argInt("times") ?? 2) + 1, tickOffset: span, semis: a.argInt("semitones") ?? -2).filter { $0.tick >= r.endTick }; keep = true
            case "quantize": out = quantizeNotes(mNotes(src), grid: max(1, Int(((a.argDbl("grid") ?? 0.25) * Double(p.ppq)).rounded())), strength: a.argDbl("strength") ?? 1)
            case "humanize": out = humanizeNotes(mNotes(src), r: R, velocity: a.argInt("amount") ?? 6, timing: a.argInt("timing") ?? 0)
            case "articulation": out = articulateNotes(mNotes(src), kind: a.argStr("articulation") ?? "detache")
            case "phrase_dynamics":
                let g = gridFor(p, r.startTick, r.endTick)
                let pb = a.argInt("phraseBars") ?? 4
                out = phraseDynamics(mNotes(src), phraseTicks: (g.first?.length ?? p.ppq * 4) * pb, depth: Double(a.argInt("amount") ?? 14), start: r.startTick)
            default: out = variationNotes(mNotes(src), key: try keyOf(p, nil), r: R, kind: a.argStr("variation") ?? "ornament")
            }
            let clean = out.map {
                GNote(id: newStudioId("note"), trackId: t.id, channel: t.channel, tick: max(0, $0.tick), duration: max(1, $0.duration),
                      pitch: max(0, min(127, $0.pitch)), velocity: max(1, min(127, $0.velocity)), offVelocity: nil)
            }
            let ops: [ProjectOp] = keep ? [.addNotes(clean)] : [.removeNotes(Set(src.map { $0.id })), .addNotes(clean)]
            return try appliedResult(store, ops, label: "\(a.argStr("transform")!) \(t.name) (\(src.count) -> \(clean.count) notes)",
                                     baseRevision: a.argInt("baseRevision"),
                                     extra: [("sourceNotes", .int(Int64(src.count))), ("resultNotes", .int(Int64(clean.count)))])
        },
        GBKTool(name: "gbk_orchestrate", description: "Track orchestration: copy (double) a passage from one track to another with an octave/semitone shift and velocity scale, folding into the target instrument's range.", inputSchema: schemaObj([
            ("sourceTrackId", schemaStr()), ("targetTrackId", schemaStr()), ("range", rangeSchemaBare),
            ("semitones", schemaInt(-48, 48)), ("velocityScale", schemaNum(0.1, 2)), ("baseRevision", baseRev),
        ], required: ["sourceTrackId", "targetTrackId", "range"]), readOnly: false) { a in
            let p = P()
            let s = try trackOf(p, a.argStr("sourceTrackId")!)
            let t = try trackOf(p, a.argStr("targetTrackId")!)
            let r = try rangeToTicks(p, rangeArg(a.argObj("range"))!)
            let spec = instrumentSpec(t.name)
            let src = p.notes.filter { $0.trackId == s.id && $0.tick >= r.startTick && $0.tick < r.endTick }
            let notes = src.map { n -> GNote in
                var pitch = n.pitch + (a.argInt("semitones") ?? 0)
                while pitch < spec.lo { pitch += 12 }
                while pitch > spec.hi { pitch -= 12 }
                return GNote(id: newStudioId("note"), trackId: t.id, channel: t.channel, tick: n.tick, duration: n.duration,
                             pitch: max(0, min(127, pitch)),
                             velocity: max(1, min(127, Int((Double(n.velocity) * (a.argDbl("velocityScale") ?? 1)).rounded()))), offVelocity: nil)
            }
            if notes.isEmpty { throw ToolArgError("INVALID_RANGE", "source has no notes in range") }
            return try appliedResult(store, [.addNotes(notes)], label: "orchestrate \(s.name) -> \(t.name) (\(notes.count))",
                                     baseRevision: a.argInt("baseRevision"), extra: [("notes", .int(Int64(notes.count)))])
        },
    ]
}
