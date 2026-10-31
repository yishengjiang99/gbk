import Foundation

// Port of src/webmcp/tools.ts (ToolDef + runTool), src/agent/tool-policy.ts and
// src/agent/tool-manifest.ts: the native tool registry the bridge executes server
// tool_calls through — same tools, same validation, same result envelope as WebMCP.

struct ToolContent: Sendable { var type: String; var mimeType: String; var data: String } // data: base64

struct ToolRunOut {
    var data: JSONValue
    var warnings: [String] = []
    var content: [ToolContent]? = nil
}

struct GBKTool: Sendable {
    var name: String
    var description: String
    var inputSchema: JSONValue
    var readOnly: Bool
    var run: @Sendable (JSONValue) async throws -> ToolRunOut
}

/// Run a tool with validation + uniform result envelope + activity logging (port of runTool).
func runTool(_ store: WorkstationStore, _ tool: GBKTool, _ args: JSONValue) async -> JSONValue {
    func envelope(ok: Bool, data: JSONValue?, warnings: [String], error: JSONValue?, content: [ToolContent]?) -> JSONValue {
        var pairs: [(String, JSONValue)] = [
            ("ok", .bool(ok)),
            ("projectId", .string(store.project.id)),
            ("revision", .int(Int64(store.project.revision))),
        ]
        if let data { pairs.append(("data", data)) }
        pairs.append(("warnings", .array(warnings.map { .string($0) })))
        if let error { pairs.append(("error", error)) }
        if let content {
            pairs.append(("content", .array(content.map {
                .object([("type", .string($0.type)), ("mimeType", .string($0.mimeType)), ("data", .string($0.data))])
            })))
        }
        return .object(pairs)
    }
    do {
        if Task.isCancelled { throw ToolArgError("OPERATION_CANCELLED", "cancelled before start") }
        let input = args
        try validateToolArgs(schema: tool.inputSchema, input)
        let r = try await tool.run(input)
        if Task.isCancelled { throw ToolArgError("OPERATION_CANCELLED", "cancelled") }
        store.log("agent", tool.name, true)
        return envelope(ok: true, data: r.data, warnings: r.warnings, error: nil, content: r.content)
    } catch let e as ToolArgError {
        store.log("agent", tool.name, false, "\(e.code): \(e.message)")
        var errPairs: [(String, JSONValue)] = [("code", .string(e.code)), ("message", .string(e.message))]
        if let details = e.details { errPairs.append(("details", details)) }
        return envelope(ok: false, data: nil, warnings: [], error: .object(errPairs), content: nil)
    } catch let e as PlainToolError {
        store.log("agent", tool.name, false, "INTERNAL_ERROR: \(e.message)")
        return envelope(ok: false, data: nil, warnings: [], error: .object([("code", .string("INTERNAL_ERROR")), ("message", .string(e.message))]), content: nil)
    } catch {
        if Task.isCancelled {
            store.log("agent", tool.name, false, "OPERATION_CANCELLED: cancelled")
            return envelope(ok: false, data: nil, warnings: [], error: .object([("code", .string("OPERATION_CANCELLED")), ("message", .string("cancelled"))]), content: nil)
        }
        let message = String(describing: error)
        store.log("agent", tool.name, false, "INTERNAL_ERROR: \(message)")
        return envelope(ok: false, data: nil, warnings: [], error: .object([("code", .string("INTERNAL_ERROR")), ("message", .string(message))]), content: nil)
    }
}

// MARK: - Policy (port of COMPOSER_TOOL_POLICY)

struct ToolPolicy: Sendable {
    var cls: String // read | mutate | render
    var force: JSONValue? = nil // arguments forced by policy, merged over the model's arguments
    var createsProject: Bool = false
}

let composerToolPolicy: [String: ToolPolicy] = [
    // discovery / reads (parallel-safe)
    "gbk_get_capabilities": ToolPolicy(cls: "read"),
    "gbk_get_project_summary": ToolPolicy(cls: "read"),
    "gbk_get_score_digest": ToolPolicy(cls: "read"),
    "gbk_list_tracks": ToolPolicy(cls: "read"),
    "gbk_get_notes": ToolPolicy(cls: "read"),
    "gbk_get_cc_events": ToolPolicy(cls: "read"),
    "gbk_get_selection": ToolPolicy(cls: "read"),
    "gbk_get_transport": ToolPolicy(cls: "read"),
    "gbk_list_presets": ToolPolicy(cls: "read"),
    "gbk_analyze_passage": ToolPolicy(cls: "read"),
    "gbk_get_voice_settings": ToolPolicy(cls: "read"),
    "gbk_get_composition_session": ToolPolicy(cls: "read"),
    "gbk_get_render_status": ToolPolicy(cls: "read"),
    "gbk_list_render_artifacts": ToolPolicy(cls: "read"),
    "gbk_get_render_artifact": ToolPolicy(cls: "read"),
    // composition (never overwrites the current project: it is checkpointed first)
    "gbk_create_project": ToolPolicy(cls: "mutate", force: .object([("replaceCurrent", .bool(false))]), createsProject: true),
    "gbk_create_track": ToolPolicy(cls: "mutate"),
    "gbk_set_tempo_map": ToolPolicy(cls: "mutate"),
    "gbk_set_time_signature_map": ToolPolicy(cls: "mutate"),
    "gbk_set_song_structure": ToolPolicy(cls: "mutate"),
    "gbk_generate_arrangement": ToolPolicy(cls: "mutate"),
    "gbk_generate_part": ToolPolicy(cls: "mutate"),
    "gbk_transform_notes": ToolPolicy(cls: "mutate"),
    "gbk_orchestrate": ToolPolicy(cls: "mutate"),
    "gbk_generate_counterpoint": ToolPolicy(cls: "mutate"),
    "gbk_generate_fugue_section": ToolPolicy(cls: "mutate"),
    // editing (proposals; outside the agent's own new project the user must Accept)
    "gbk_set_instrument": ToolPolicy(cls: "mutate"),
    "gbk_set_track_mix": ToolPolicy(cls: "mutate"),
    "gbk_select_passage": ToolPolicy(cls: "mutate"),
    "gbk_propose_note_patch": ToolPolicy(cls: "mutate"),
    "gbk_propose_cc_patch": ToolPolicy(cls: "mutate"),
    "gbk_generate_cc_curve": ToolPolicy(cls: "mutate"),
    "gbk_propose_track_patch": ToolPolicy(cls: "mutate"),
    "gbk_propose_voice_patch": ToolPolicy(cls: "mutate"),
    "gbk_set_effects": ToolPolicy(cls: "mutate"),
    "gbk_commit_proposal": ToolPolicy(cls: "mutate"),
    "gbk_discard_proposal": ToolPolicy(cls: "mutate"),
    "gbk_undo": ToolPolicy(cls: "mutate"),
    "gbk_redo": ToolPolicy(cls: "mutate"),
    // rendering: local only, artifact output, never a download, never bytes to the model
    "gbk_render_wav": ToolPolicy(cls: "render", force: .object([("output", .string("artifact")), ("download", .bool(false)), ("waitSeconds", .int(600))])),
    "gbk_cancel_render": ToolPolicy(cls: "mutate"),
]

func policyFor(_ name: String) -> ToolPolicy? { composerToolPolicy[name] }

// MARK: - Manifest (port of composerManifest + manifestHash)

func manifestHash(_ tools: [(name: String, inputSchema: JSONValue)]) -> String {
    let sorted = tools.sorted { $0.name < $1.name } // TS localeCompare: tool names are ASCII snake_case
    let pairs = sorted.map { JSONValue.array([.string($0.name), $0.inputSchema]) }
    return fnv1aHex(JSONValue.array(pairs).canonical) // JSONValue.canonical is the TS `canon`
}

struct ComposerManifest {
    var hash: String
    var tools: [JSONValue] // [{name, description, inputSchema, readOnly, cls}]
}

func composerManifest(_ tools: [GBKTool]) -> ComposerManifest {
    var list: [JSONValue] = []
    var hashInput: [(name: String, inputSchema: JSONValue)] = []
    for t in tools {
        guard let pol = policyFor(t.name) else { continue }
        list.append(.object([
            ("name", .string(t.name)),
            ("description", .string(t.description)),
            ("inputSchema", t.inputSchema),
            ("readOnly", .bool(t.readOnly)),
            ("cls", .string(pol.cls)),
        ]))
        hashInput.append((t.name, t.inputSchema))
    }
    return ComposerManifest(hash: manifestHash(hashInput), tools: list)
}

/// The full registry (port of buildAllTools in src/webmcp/registry.ts).
func buildAllTools(_ store: WorkstationStore) -> [GBKTool] {
    buildCoreTools(store) + buildMusicTools(store) + buildComposeTools(store)
        + buildArrangementTools(store) + buildSoundTools(store) + buildRenderTools(store)
}
