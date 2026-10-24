// Shared (browser + server) policy for the integrated AI Composer. Pure data: no DOM, no controller imports.
// The server only ever offers / dispatches tools listed here, whatever a browser manifest claims, and the browser
// bridge refuses anything not listed here too (defense in depth).
export type ToolClass = "read" | "mutate" | "render";
export interface ToolPolicy {
  cls: ToolClass;
  /** Arguments forced by policy (merged over the model's arguments before validation). */
  force?: Record<string, unknown>;
  /** Only allowed while the run has the user's "new composition" consent (a user prompt started it). */
  createsProject?: boolean;
}

export const COMPOSER_TOOL_POLICY: Record<string, ToolPolicy> = {
  // discovery / reads (parallel-safe)
  gbk_get_capabilities: { cls: "read" },
  gbk_get_project_summary: { cls: "read" },
  gbk_list_tracks: { cls: "read" },
  gbk_get_notes: { cls: "read" },
  gbk_get_cc_events: { cls: "read" },
  gbk_get_selection: { cls: "read" },
  gbk_get_transport: { cls: "read" },
  gbk_list_presets: { cls: "read" },
  gbk_analyze_passage: { cls: "read" },
  gbk_get_voice_settings: { cls: "read" },
  gbk_get_composition_session: { cls: "read" },
  gbk_get_render_status: { cls: "read" },
  gbk_list_render_artifacts: { cls: "read" },
  gbk_get_render_artifact: { cls: "read" },
  // composition (never overwrites the current project: it is checkpointed first)
  gbk_create_project: { cls: "mutate", createsProject: true, force: { replaceCurrent: false } },
  gbk_create_track: { cls: "mutate" },
  gbk_set_tempo_map: { cls: "mutate" },
  gbk_set_time_signature_map: { cls: "mutate" },
  gbk_set_song_structure: { cls: "mutate" },
  gbk_generate_arrangement: { cls: "mutate" },
  gbk_generate_part: { cls: "mutate" },
  gbk_transform_notes: { cls: "mutate" },
  gbk_orchestrate: { cls: "mutate" },
  gbk_generate_counterpoint: { cls: "mutate" },
  gbk_generate_fugue_section: { cls: "mutate" },
  // editing (proposals; outside the agent's own new project the user must Accept)
  gbk_set_instrument: { cls: "mutate" },
  gbk_set_track_mix: { cls: "mutate" },
  gbk_select_passage: { cls: "mutate" },
  gbk_propose_note_patch: { cls: "mutate" },
  gbk_propose_cc_patch: { cls: "mutate" },
  gbk_generate_cc_curve: { cls: "mutate" },
  gbk_propose_track_patch: { cls: "mutate" },
  gbk_propose_voice_patch: { cls: "mutate" },
  gbk_set_effects: { cls: "mutate" },
  gbk_commit_proposal: { cls: "mutate" },
  gbk_discard_proposal: { cls: "mutate" },
  gbk_undo: { cls: "mutate" },
  gbk_redo: { cls: "mutate" },
  // rendering: local only, artifact output, never a download, never bytes to the model
  // waitSeconds: the in-page render has its own timeout/stall watchdog; never hand the agent a still-running job.
  gbk_render_wav: { cls: "render", force: { output: "artifact", download: false, waitSeconds: 600 } },
  gbk_cancel_render: { cls: "mutate" },
};
// Deliberately NOT exposed to the server agent: gbk_read_wav_bytes (would relay media through the LLM),
// gbk_download_render_artifact / gbk_prepare_*_export (downloads need a user gesture), gbk_delete_render_artifact
// (deleting user data), gbk_set_transport / gbk_preview_proposal (live audio needs the user's click).

export function policyFor(name: string): ToolPolicy | null {
  return Object.prototype.hasOwnProperty.call(COMPOSER_TOOL_POLICY, name) ? COMPOSER_TOOL_POLICY[name] : null;
}

/** Stable hash of a manifest (names + schemas) so both sides can tell they agree. FNV-1a over canonical JSON. */
export function manifestHash(tools: { name: string; inputSchema: unknown }[]): string {
  const canon = (v: unknown): string => Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);
  const s = canon([...tools].sort((a, b) => a.name.localeCompare(b.name)).map((t) => [t.name, t.inputSchema]));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
