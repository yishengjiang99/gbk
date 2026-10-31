import Foundation

// Port of buildMusicTools in src/webmcp/music-tools.ts.

func buildMusicTools(_ store: WorkstationStore) -> [GBKTool] {
    let P = { store.project }
    func tpb(_ p: Project) -> Int { bars(p, upToTick: 1).first.map { $0.endTick - $0.startTick } ?? p.ppq * 4 }
    return [
        GBKTool(name: "gbk_analyze_passage", description: "Deterministic stats for a passage: pitch classes, range, density, intervals, recurring motifs, approximate key (heuristic), cadence candidates (heuristic).", inputSchema: schemaObj([
            ("range", rangeSchemaBare),
            ("trackIds", schemaArray(items: .object([("type", .string("string")), ("maxLength", .int(200))]), maxItems: 64)),
        ], required: ["range"]), readOnly: true) { a in
            let p = P()
            let r = try rangeToTicks(p, rangeArg(a.argObj("range"))!)
            let ids = try a.argStrs("trackIds").map { Set(try $0.map { try trackOfPlain(p, $0).id }) }
            let ns = p.notes.filter { $0.tick >= r.startTick && $0.tick < r.endTick && (ids == nil || ids!.contains($0.trackId)) }
            let an = analyzeNotes(mNotes(ns), ppq: p.ppq, ticksPerBar: tpb(p))
            let sorted = ns.sorted { ($0.tick, $0.pitch) < ($1.tick, $1.pitch) }
            var bassLine: [GNote] = []
            for (i, n) in sorted.enumerated() where i == 0 || sorted[i - 1].tick != n.tick { bassLine.append(n) }
            let tonic = an["key"]?["tonic"]?.intValue ?? 0
            let cads = detectCadences(bass: mNotes(bassLine), tonic: tonic, ticksPerBar: tpb(p))
            var pairs: [(String, JSONValue)] = [("startTick", .int(Int64(r.startTick))), ("endTick", .int(Int64(r.endTick)))]
            if case .object(let anPairs) = an { pairs.append(contentsOf: anPairs) }
            pairs.append(("cadences", .array(cads.map { .object([("tick", .int(Int64($0.tick))), ("type", .string($0.type))]) })))
            return ToolRunOut(data: .object(pairs), warnings: ["key and cadence labels are heuristics"])
        },
        GBKTool(name: "gbk_generate_counterpoint", description: "Generate a counterpoint line (heuristic species-style rules: consonance on strong beats, voice order, contrary motion preference, parallel 5th/8ve avoidance) against a cantus track over a range. Returns a proposal for the best candidate plus ranked alternatives.", inputSchema: schemaObj([
            ("cantusTrackId", .object([("type", .string("string")), ("maxLength", .int(200))])),
            ("range", rangeSchemaBare),
            ("targetTrackId", schemaStr(nil, extra: [("description", .string("existing track to write into; omit to create a new track"))])),
            ("newTrackName", .object([("type", .string("string")), ("maxLength", .int(64))])),
            ("channel", schemaInt(0, 15)),
            ("register", schemaObj([("low", schemaInt(0, 127)), ("high", schemaInt(0, 127))], required: ["low", "high"])),
            ("position", schemaEnum(["above", "below"])),
            ("rhythmComplexity", schemaInt(1, 3, "1 = note against note, 2 = two per beat, 3 = four per beat")),
            ("seed", schemaInt(0, 2147483648)),
            ("candidates", schemaInt(1, 8)),
            ("baseRevision", schemaInt(0, 9007199254740991)),
        ], required: ["cantusTrackId", "range"]), readOnly: false) { a in
            let p = P()
            let r = try rangeToTicks(p, rangeArg(a.argObj("range"))!)
            let cantusT = try trackOfPlain(p, a.argStr("cantusTrackId")!)
            let cantus = p.notes.filter { $0.trackId == cantusT.id && $0.tick < r.endTick && $0.tick + $0.duration > r.startTick }
            if cantus.isEmpty { throw ToolArgError("INVALID_RANGE", "cantus track has no notes in range") }
            let key = estimateKey(mNotes(p.notes.filter { $0.tick >= r.startTick && $0.tick < r.endTick }))
            let reg = a.argObj("register").map { (low: $0.argInt("low")!, high: $0.argInt("high")!) } ?? (low: 55, high: 74)
            if reg.high - reg.low < 7 { throw ToolArgError("INVALID_ARGUMENT", "register must span at least a fifth") }
            let base = a.argInt("seed") ?? 1
            let n = a.argInt("candidates") ?? 3
            var cands: [(seed: Int, notes: [MNote], score: Double, issues: [String])] = []
            for i in 0..<n {
                let res = counterpoint(cantus: mNotes(cantus), CounterpointOpts(
                    lo: reg.low, hi: reg.high, rhythm: a.argInt("rhythmComplexity") ?? 1, seed: base + i,
                    startTick: r.startTick, endTick: r.endTick, ppq: p.ppq, velocity: nil,
                    tonic: key.tonic, mode: key.mode, above: a.argStr("position") != "below"))
                cands.append((base + i, res.notes, res.score, res.issues))
            }
            cands.sort { $0.score > $1.score }
            let best = cands[0]
            var ops: [ProjectOp] = []
            var tid: String
            var ch: Int
            if let targetId = a.argStr("targetTrackId") {
                let target = try trackOfPlain(p, targetId)
                tid = target.id; ch = a.argInt("channel") ?? target.channel
            } else {
                tid = newStudioId("trk")
                ch = a.argInt("channel") ?? ((p.tracks.map { $0.channel }.max() ?? -1) + 1) % 16
                if ch == 9 { ch = 10 }
                let name = String((a.argStr("newTrackName") ?? "Counterpoint").prefix(64))
                let color = trackColors[p.tracks.count % trackColors.count]
                ops.append(.addTrack(GTrack(id: tid, name: name, channel: ch, color: color, mix: TrackMix(), visible: true, role: nil), index: nil))
            }
            ops.append(.addNotes(best.notes.map {
                GNote(id: newStudioId("note"), trackId: tid, channel: ch, tick: $0.tick, duration: $0.duration, pitch: $0.pitch, velocity: $0.velocity, offVelocity: nil)
            }))
            let pr = try store.propose(ops, baseRevision: a.argInt("baseRevision"), source: "agent",
                                       summary: "counterpoint (\(a.argStr("position") ?? "above") \(cantusT.name), seed \(best.seed), key≈\(key.label))")
            var data = proposalViewJSON(pr)
            if case .object(var pairs) = data {
                pairs.append(("key", .object([
                    ("label", .string(key.label)), ("tonic", .int(Int64(key.tonic))), ("mode", .string(key.mode)),
                    ("confidence", .number(key.confidence)), ("method", .string(key.method)),
                ])))
                pairs.append(("candidates", .array(cands.map {
                    .object([("seed", .int(Int64($0.seed))), ("score", .number($0.score)), ("notes", .int(Int64($0.notes.count))), ("issues", .array($0.issues.map { .string($0) }))])
                })))
                pairs.append(("chosenSeed", .int(Int64(best.seed))))
                data = .object(pairs)
            }
            return ToolRunOut(data: data, warnings: ["counterpoint rules and key are heuristics"] + best.issues)
        },
        GBKTool(name: "gbk_generate_fugue_section", description: "Generate a fugue exposition with GBK's Bach generator (real generator, seeded) and stage it as new tracks starting at a bar. Only options the generator supports are accepted.", inputSchema: schemaObj([
            ("key", schemaEnum(bachKeyOptions)),
            ("voices", .object([("type", .string("integer")), ("enum", .array([.int(3), .int(4)]))])),
            ("length", schemaEnum(["short", "medium", "long"])),
            ("complexity", schemaInt(1, 5)),
            ("seed", schemaInt(0, 2147483648)),
            ("atBar", schemaInt(1, 10000)),
            ("maxBars", schemaInt(1, 64)),
            ("register", schemaObj([("low", schemaInt(0, 127)), ("high", schemaInt(0, 127))], required: ["low", "high"])),
        ]), readOnly: false) { a in
            let p = P()
            let gen = try parseSmf(generateBachMidi(key: a.argStr("key"), length: a.argStr("length"),
                                                    voices: a.argInt("voices"), complexity: a.argInt("complexity"),
                                                    seed: a.argInt("seed") ?? 7).midiData, name: "fugue")
            let scale = Double(p.ppq) / Double(gen.ppq)
            let atBar = a.argInt("atBar") ?? 1
            let at = try rangeToTicks(p, (unit: "bars", start: Double(atBar), end: Double(atBar))).startTick
            let genBarLen = bars(gen, upToTick: 1).first.map { $0.endTick - $0.startTick } ?? gen.ppq * 4
            let maxT = a.argInt("maxBars").map { Int((Double(genBarLen) * Double($0)).rounded()) } ?? Int.max
            var ops: [ProjectOp] = []
            var ch = max(-1, p.tracks.map { $0.channel }.max() ?? -1)
            var addedTracks = 0
            for gt in gen.tracks {
                let ns = gen.notes.filter { $0.trackId == gt.id && $0.tick < maxT }
                if ns.isEmpty { continue }
                var pitches = ns.map { $0.pitch }
                if let reg = a.argObj("register") {
                    pitches = fitRangeNotes(mNotes(ns), lo: reg.argInt("low")!, hi: reg.argInt("high")!).map { $0.pitch }
                }
                ch = (ch + 1) % 16; if ch == 9 { ch = 10 }
                let id = newStudioId("trk")
                let color = trackColors[(p.tracks.count + addedTracks) % trackColors.count]
                addedTracks += 1
                ops.append(.addTrack(GTrack(id: id, name: String("Fugue \(gt.name)".prefix(64)), channel: ch, color: color, mix: TrackMix(), visible: true, role: nil), index: nil))
                ops.append(.addNotes(ns.enumerated().map { (i, n) in
                    GNote(id: newStudioId("note"), trackId: id, channel: ch,
                          tick: at + Int((Double(n.tick) * scale).rounded()), duration: max(1, Int((Double(n.duration) * scale).rounded())),
                          pitch: pitches[i], velocity: n.velocity, offVelocity: nil)
                }))
            }
            let pr = try store.propose(ops, source: "agent", summary: "fugue section (\(a.argStr("key") ?? "default key"), seed \(a.argInt("seed") ?? 7))")
            return ToolRunOut(data: proposalViewJSON(pr), warnings: ["generated material comes from GBK's rule-based Bach-style generator"])
        },
    ]
}
