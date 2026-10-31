import Foundation

// Port of buildSoundTools in src/webmcp/sound-tools.ts.

func buildSoundTools(_ store: WorkstationStore) -> [GBKTool] {
    let P = { store.project }
    let paramDoc = voiceParams.map { "\($0.name) (\($0.unit))" }.joined(separator: ", ")
    let effectsRangeDoc = ["roomSize", "damping", "reverbLevel", "chorusLevel", "chorusDepthMs", "chorusRateHz", "chorusDelayMs"]
        .map { k in "\(k) \(jsNum(effectsRanges[k]!.min))..\(jsNum(effectsRanges[k]!.max))" }.joined(separator: ", ")
    var effectsSchemaPairs: [(String, JSONValue)] = [("enabled", schemaBool())]
    for k in ["roomSize", "damping", "reverbLevel", "chorusLevel", "chorusDepthMs", "chorusRateHz", "chorusDelayMs"] {
        effectsSchemaPairs.append((k, schemaNum(effectsRanges[k]!.min, effectsRanges[k]!.max)))
    }
    effectsSchemaPairs.append(("summary", schemaStr()))
    effectsSchemaPairs.append(("baseRevision", baseRevSchemaShort))
    return [
        GBKTool(name: "gbk_get_voice_settings", description: "Effective SoundFont voice settings of a track's preset for a key/velocity: per zone, the generators (zone + overrides) in human units (seconds, Hz, dB, cents, %), the effective reverb/chorus send (zone gen16/15 + CC91/93 default modulators + overrides), current overrides and global effects.", inputSchema: schemaObj([
            ("trackId", schemaStr()), ("key", schemaInt(0, 127, "MIDI key (default 60)")), ("velocity", schemaInt(1, 127, "default 100")),
        ], required: ["trackId"]), readOnly: true) { a in
            let t = try trackOfPlain(P(), a.argStr("trackId")!)
            await store.host.ensureSoundFont?()
            let host = store.host.trackRegionsJSON?(P(), t.id)
            let rep = voiceReportJSON(P(), t.id, host, key: a.argInt("key") ?? 60, velocity: a.argInt("velocity") ?? 100, tick: store.transport.positionTick)
            let zoneCount = rep["zones"]?.arrayValue?.count ?? 0
            return ToolRunOut(data: rep, warnings: host != nil
                ? (zoneCount > 0 ? [] : ["no zone of this preset covers that key/velocity"])
                : ["SoundFont not available (renderer SoundFont failed to load); overrides and effects shown only"])
        },
        GBKTool(name: "gbk_propose_voice_patch", description: "Stage SF2 voice overrides for a track (layered on the SoundFont zones; applied at note-on, realtime ones also to sounding notes). Each edit: param, mode set (absolute, in the param unit) | add (delta; dB/cents/%/semitones params) | scale (factor for seconds/Hz params), optional keyLo/keyHi. Ranges follow SF2 2.01 8.1.3. Params: \(paramDoc). Returns a proposal: preview A/B, then commit (user approves).", inputSchema: schemaObj([
            ("trackId", schemaStr()),
            ("edits", schemaArray(items: schemaObj([
                ("param", schemaEnum(voiceParams.map { $0.name })),
                ("mode", schemaEnum(["set", "add", "scale"])),
                ("value", .object([("type", .string("number"))])),
                ("keyLo", schemaInt(0, 127)), ("keyHi", schemaInt(0, 127)),
            ], required: ["param", "mode", "value"]), maxItems: 64)),
            ("replace", schemaBool("true: the edits become the track's whole override list (empty edits = reset to SoundFont)")),
            ("summary", schemaStr()), ("baseRevision", baseRevSchemaShort),
        ], required: ["trackId", "edits"]), readOnly: false) { a in
            let t = try trackOfPlain(P(), a.argStr("trackId")!)
            var overrides: [VoiceOverride] = []
            for e in a.argArr("edits") ?? [] {
                let edit: HumanEdit
                switch e.argStr("mode") {
                case "set": edit = .set(e.argDbl("value")!)
                case "scale": edit = .scale(e.argDbl("value")!)
                default: edit = .add(e.argDbl("value")!)
                }
                var o = try humanEditToOverride(param: e.argStr("param")!, edit: edit).get()
                o.keyLo = e.argInt("keyLo"); o.keyHi = e.argInt("keyHi")
                overrides.append(o)
            }
            if overrides.isEmpty && a.argBool("replace") != true {
                throw ToolArgError("INVALID_ARGUMENT", "edits is empty (use replace: true to reset)")
            }
            let pr = try store.propose([.setVoicePatch(trackId: t.id, overrides: overrides, merge: a.argBool("replace") != true)],
                                       baseRevision: a.argInt("baseRevision"), source: "agent",
                                       summary: a.argStr("summary") ?? "voice patch \(t.name)")
            var data = proposalViewJSON(pr)
            if case .object(var pairs) = data {
                pairs.append(("overrides", .array(overrides.map { $0.json })))
                data = .object(pairs)
            }
            return ToolRunOut(data: data, warnings: pr.warnings)
        },
        GBKTool(name: "gbk_set_effects", description: "Stage global reverb (Freeverb-style) / chorus (modulated delay) parameters as a proposal. Ranges: \(effectsRangeDoc); enabled=false is the off switch. Defaults {\"enabled\":true,\"roomSize\":0.5,\"damping\":0.5,\"reverbLevel\":0.5,\"chorusLevel\":0.7,\"chorusDepthMs\":4,\"chorusRateHz\":0.6,\"chorusDelayMs\":12}. How much of each note reaches the effects is per voice: gbk_propose_voice_patch reverbSend/chorusSend or CC91/CC93 automation.", inputSchema: schemaObj(effectsSchemaPairs), readOnly: false) { a in
            var params = EffectsParams()
            var any = false
            if let v = a.argBool("enabled") { params.enabled = v; any = true }
            if let v = a.argDbl("roomSize") { params.roomSize = v; any = true }
            if let v = a.argDbl("damping") { params.damping = v; any = true }
            if let v = a.argDbl("reverbLevel") { params.reverbLevel = v; any = true }
            if let v = a.argDbl("chorusLevel") { params.chorusLevel = v; any = true }
            if let v = a.argDbl("chorusDepthMs") { params.chorusDepthMs = v; any = true }
            if let v = a.argDbl("chorusRateHz") { params.chorusRateHz = v; any = true }
            if let v = a.argDbl("chorusDelayMs") { params.chorusDelayMs = v; any = true }
            if !any { throw ToolArgError("INVALID_ARGUMENT", "no effects parameter given") }
            let pr = try store.propose([.setEffects(params)], baseRevision: a.argInt("baseRevision"), source: "agent",
                                       summary: a.argStr("summary") ?? "effects")
            return ToolRunOut(data: proposalViewJSON(pr), warnings: pr.warnings)
        },
    ]
}
