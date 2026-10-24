// gbk_* WebMCP tools: thin, validated wrappers over WorkstationController (no agent-only state copy).
import type { WorkstationController } from "../workstation/controller.ts";
import { WorkstationError } from "../workstation/ops.ts";
import type { Op } from "../workstation/ops.ts";
import type { Project, Note } from "../workstation/model.ts";
import { barBeatToTick, secToTick, tickToSec, tickToBarBeat } from "../workstation/timing.ts";
import { generateCurve, type CurveShape } from "../workstation/curves.ts";
import { serializeSmf } from "../workstation/smf.ts";

export type JsonSchema = Record<string, unknown>;
/** Non-text MCP content (e.g. a small WAV as audio). Never JSON-stringified into a text result. */
export type ToolContent = { type: "audio" | "image"; mimeType: string; data: string };
type RunOut = { data: unknown; warnings?: string[]; content?: ToolContent[] };
export interface ToolDef {
  name: string; description: string; inputSchema: JsonSchema; readOnly: boolean;
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<RunOut> | RunOut;
}
export interface ToolResult { ok: boolean; projectId: string; revision: number; data?: unknown; warnings: string[]; error?: { code: string; message: string; details?: unknown }; content?: ToolContent[] }

// ---- schema helpers ------------------------------------------------------------
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
const int = (min: number, max: number, description?: string): JsonSchema => ({ type: "integer", minimum: min, maximum: max, ...(description ? { description } : {}) });
const str = (description?: string, extra: JsonSchema = {}): JsonSchema => ({ type: "string", maxLength: 200, ...(description ? { description } : {}), ...extra });
const UNIT = { type: "string", enum: ["bars", "beats", "ticks", "seconds"], description: "Coordinate unit. bars are 1-based (bar 9 = start of bar 9); beats are 0-based quarter-of-meter beats from song start; ticks use the file PPQ; seconds follow the tempo map." };
const RANGE = obj({ unit: UNIT, start: { type: "number", minimum: 0 }, end: { type: "number", minimum: 0, description: "For bars the end bar is inclusive (bars 9..16 covers through the end of bar 16)." } }, ["unit", "start", "end"]);
const BASE_REV = int(0, Number.MAX_SAFE_INTEGER, "Optimistic concurrency: the revision your edit is based on. Returns STALE_REVISION if the project changed.");

/** Strict-ish runtime validation for the subset of JSON Schema used here (agents can send anything). */
export function validate(schema: JsonSchema, v: unknown, path = "input"): void {
  const bad = (m: string) => { throw new WorkstationError("INVALID_ARGUMENT", `${path}: ${m}`); };
  if (Array.isArray(schema.anyOf)) {
    const errs: string[] = [];
    for (const alt of schema.anyOf as JsonSchema[]) { try { validate(alt, v, path); return; } catch (e) { errs.push((e as Error).message.replace(`${path}: `, "")); } }
    bad(errs.join(" or "));
  }
  const t = schema.type;
  if (t === "object") {
    if (typeof v !== "object" || v === null || Array.isArray(v)) bad("expected object");
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const r of (schema.required as string[] | undefined) ?? []) if ((v as Record<string, unknown>)[r] === undefined) bad(`missing ${r}`);
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (!props[k]) { if (schema.additionalProperties === false) bad(`unexpected property ${k}`); continue; }
      validate(props[k], val, `${path}.${k}`);
    }
  } else if (t === "array") {
    if (!Array.isArray(v)) bad("expected array");
    const arr = v as unknown[];
    if (typeof schema.maxItems === "number" && arr.length > schema.maxItems) bad(`at most ${schema.maxItems} items`);
    arr.forEach((x, i) => validate(schema.items as JsonSchema, x, `${path}[${i}]`));
  } else if (t === "integer" || t === "number") {
    if (typeof v !== "number" || !Number.isFinite(v) || (t === "integer" && !Number.isInteger(v))) bad(`expected ${t}`);
    if (typeof schema.minimum === "number" && (v as number) < schema.minimum) bad(`must be >= ${schema.minimum}`);
    if (typeof schema.maximum === "number" && (v as number) > schema.maximum) bad(`must be <= ${schema.maximum}`);
  } else if (t === "string") {
    if (typeof v !== "string") bad("expected string");
    if (typeof schema.maxLength === "number" && (v as string).length > schema.maxLength) bad("too long");
    if (Array.isArray(schema.enum) && !schema.enum.includes(v)) bad(`must be one of ${schema.enum.join(", ")}`);
  } else if (t === "boolean") {
    if (typeof v !== "boolean") bad("expected boolean");
  }
}

export function toTick(p: Project, unit: string, value: number, isEnd = false): number {
  switch (unit) {
    case "ticks": return Math.round(value);
    case "seconds": return secToTick(p, value);
    case "bars": return barBeatToTick(p, isEnd ? value + 1 : value);
    case "beats": { const b = barBeatToTick(p, 1, value); return b; }
  }
  throw new WorkstationError("INVALID_ARGUMENT", `unknown unit ${unit}`);
}
export function rangeToTicks(p: Project, r: { unit: string; start: number; end: number }) {
  const startTick = toTick(p, r.unit, r.start), endTick = toTick(p, r.unit, r.end, true);
  if (!(endTick > startTick)) throw new WorkstationError("INVALID_RANGE", "range end must be after start");
  return { startTick, endTick };
}
const trackOf = (p: Project, id: string) => {
  const t = p.tracks.find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase());
  if (!t) throw new WorkstationError("INVALID_ARGUMENT", `unknown track ${JSON.stringify(id.slice(0, 60))}; call gbk_list_tracks`);
  return t;
};

/** CC capability truth table for the built-in SF2 engine. */
export const CC_CAPS: Record<number, { name: string; audible: boolean; note?: string }> = {
  1: { name: "Modulation", audible: true, note: "SF2 default modulator -> vibrato LFO pitch depth" },
  7: { name: "Volume", audible: true }, 10: { name: "Pan", audible: true }, 11: { name: "Expression", audible: true },
  64: { name: "Sustain", audible: true }, 66: { name: "Sostenuto", audible: true }, 67: { name: "Soft pedal", audible: true },
  71: { name: "Resonance", audible: false, note: "routed + stored; audible only if the preset defines a CC71 modulator" },
  74: { name: "Brightness", audible: false, note: "routed + stored; audible only if the preset defines a CC74 modulator" },
  91: { name: "Reverb send", audible: true, note: "SF2 2.01 default modulator 8.4.8: adds up to 20% reverb send (0.1% x 200 at CC 127) on top of the zone's reverbEffectsSend" },
  93: { name: "Chorus send", audible: true, note: "SF2 2.01 default modulator 8.4.9: adds up to 20% chorus send on top of the zone's chorusEffectsSend" },
};

const NOTE_SCHEMA = obj({ trackId: str(), tick: int(0, 1e9), duration: int(1, 1e9), pitch: int(0, 127), velocity: int(1, 127), channel: int(0, 15, "defaults to the track channel") }, ["trackId", "tick", "duration", "pitch", "velocity"]);

export function buildCoreTools(c: WorkstationController): ToolDef[] {
  const P = () => c.project;
  const summary = () => {
    const p = P();
    return { name: p.name, ppq: p.ppq, revision: p.revision, endTick: p.endTick, durationSec: +tickToSec(p, p.endTick).toFixed(3), bars: tickToBarBeat(p, p.endTick).bar, tempos: p.tempos.slice(0, 32), timeSigs: p.timeSigs.slice(0, 32), trackCount: p.tracks.length, noteCount: p.notes.length, ccCount: p.ccs.length, pendingProposals: c.getState().proposals.filter((x) => x.status === "pending").map((x) => ({ id: x.id, summary: x.summary })) };
  };
  return [
    { name: "gbk_get_capabilities", readOnly: true, description: "What this GBK build can and cannot do (implemented tools, audible vs stored-only CCs, audio readiness).", inputSchema: obj({}),
      run: () => ({ data: { audioReady: c.getState().transport.audioReady, controllers: CC_CAPS, otherControllers: "CC 0-127 are preserved, scheduled and exported; unlisted CCs only matter if the SoundFont preset maps them", pitchBend: "14-bit, audible (default range 2 semitones, RPN0 supported)", pressure: "channel + poly pressure routed to SF2 modulators",
        effects: { reverb: "Freeverb-style stereo (8 combs + 4 allpasses), driven per voice by SF2 reverbEffectsSend (gen 16) + CC91; params via gbk_set_effects", chorus: "two quadrature-modulated delay lines, driven by chorusEffectsSend (gen 15) + CC93", offlineWav: true, deterministic: true },
        voiceEditing: { tools: ["gbk_get_voice_settings", "gbk_propose_voice_patch", "gbk_set_effects"], scope: "per track, optional key range; applied at note-on (realtime generators also update sounding notes)", midiExport: "additive overrides without key range export as SF2 NRPNs (CC99=120); absolute / key-ranged overrides and effects params are project-only" },
        unsupported: ["arbitrary JS/DOM/filesystem/network", "per-preset effects types / GS-XG effect macros", "SMPTE time division"], approval: "commit_proposal from an agent requires the user to press Accept in the GBK proposal panel" } }) },
    { name: "gbk_get_project_summary", readOnly: true, description: "Project name, PPQ, tempo/meter maps, counts, revision, pending proposals.", inputSchema: obj({}), run: () => ({ data: summary() }) },
    { name: "gbk_list_tracks", readOnly: true, description: "Tracks with stable ids, names, channels, mix defaults, note counts and program.", inputSchema: obj({}),
      run: () => ({ data: P().tracks.map((t) => ({ id: t.id, name: t.name, channel: t.channel, mix: t.mix, override: c.getState().overrides[t.id] ?? null, visible: t.visible, notes: P().notes.filter((n) => n.trackId === t.id).length, program: P().programs.find((g) => g.trackId === t.id) ?? null })) }) },
    { name: "gbk_get_notes", readOnly: true, description: "Notes filtered by range/tracks/pitch, paginated (max 500 per page).", inputSchema: obj({ range: RANGE, trackIds: { type: "array", items: str(), maxItems: 64 }, minPitch: int(0, 127), maxPitch: int(0, 127), offset: int(0, 1e7), limit: int(1, 500) }),
      run: (a) => {
        const p = P(); const r = a.range ? rangeToTicks(p, a.range as never) : { startTick: 0, endTick: Infinity };
        const ids = a.trackIds ? new Set((a.trackIds as string[]).map((x) => trackOf(p, x).id)) : null;
        const all = p.notes.filter((n) => n.tick < r.endTick && n.tick + n.duration > r.startTick && (!ids || ids.has(n.trackId)) && n.pitch >= ((a.minPitch as number) ?? 0) && n.pitch <= ((a.maxPitch as number) ?? 127));
        const off = (a.offset as number) ?? 0, lim = (a.limit as number) ?? 200;
        return { data: { total: all.length, offset: off, notes: all.slice(off, off + lim), nextOffset: off + lim < all.length ? off + lim : null } };
      } },
    { name: "gbk_get_cc_events", readOnly: true, description: "Timed CC events in a range plus the effective value of each controller at the range start.", inputSchema: obj({ range: RANGE, trackId: str(), controller: int(0, 127), limit: int(1, 2000) }, ["trackId"]),
      run: (a) => {
        const p = P(); const t = trackOf(p, a.trackId as string); const r = a.range ? rangeToTicks(p, a.range as never) : { startTick: 0, endTick: Infinity };
        const evs = p.ccs.filter((e) => e.trackId === t.id && (a.controller === undefined || e.controller === a.controller));
        const eff: Record<string, number> = {};
        for (const e of evs) if (e.tick <= r.startTick) eff[`ch${e.channel + 1}_cc${e.controller}`] = e.value;
        const inR = evs.filter((e) => e.tick >= r.startTick && e.tick < r.endTick);
        return { data: { effectiveAtStart: eff, mixDefaults: t.mix, total: inR.length, events: inR.slice(0, (a.limit as number) ?? 500) } };
      } },
    { name: "gbk_get_selection", readOnly: true, description: "Current selection and loop (shared with the UI).", inputSchema: obj({}), run: () => ({ data: { selection: P().selection, loop: P().loop } }) },
    { name: "gbk_get_transport", readOnly: true, description: "Playback state and position (ticks, seconds, bar/beat).", inputSchema: obj({}),
      run: () => { const t = c.getState().transport; return { data: { ...t, positionSec: +tickToSec(P(), t.positionTick).toFixed(3), ...tickToBarBeat(P(), t.positionTick) } }; } },
    { name: "gbk_list_presets", readOnly: true, description: "SoundFont presets available for gbk_set_instrument.", inputSchema: obj({ query: str(), limit: int(1, 500) }),
      run: async (a) => { await c.host.ensureSoundFont?.(); const all = c.host.listPresets?.() ?? []; const q = ((a.query as string) ?? "").toLowerCase(); return { data: all.filter((x) => !q || x.name.toLowerCase().includes(q)).slice(0, (a.limit as number) ?? 200), warnings: all.length ? [] : ["no SoundFont loaded"] }; } },
    { name: "gbk_set_transport", readOnly: false, description: "play | pause | stop | seek | loop. Audio may require a user click first (AUDIO_NOT_READY).", inputSchema: obj({ action: { type: "string", enum: ["play", "pause", "stop", "seek", "loop"] }, position: obj({ unit: UNIT, value: { type: "number", minimum: 0 } }, ["unit", "value"]), loopRange: RANGE, loopEnabled: { type: "boolean" } }, ["action"]),
      run: async (a) => {
        const p = P();
        if (a.position) c.seek(toTick(p, (a.position as { unit: string }).unit, (a.position as { value: number }).value));
        switch (a.action) {
          case "play": await c.play(); break; case "pause": c.pause(); break; case "stop": c.stop(); break;
          case "seek": if (!a.position) throw new WorkstationError("INVALID_ARGUMENT", "seek needs position"); break;
          case "loop": { const r = a.loopRange ? rangeToTicks(p, a.loopRange as never) : { startTick: p.loop.startTick, endTick: p.loop.endTick }; c.setLoop({ ...r, enabled: (a.loopEnabled as boolean) ?? true }); }
        }
        return { data: c.getState().transport };
      } },
    { name: "gbk_set_track_mix", readOnly: false, description: "Set track mix. mode=default edits the persisted mix (undoable; volume is a post-engine fader (v/100)^2 applied live and in renders, on top of authored CC7; pan/expression are the base layer under authored CC automation); mode=override is a temporary live override (not saved); mode=clear_override removes it. Never rewrites authored CC events.", inputSchema: obj({ trackId: str(), mode: { type: "string", enum: ["default", "override", "clear_override"] }, volume: int(0, 127), pan: int(0, 127, "0=left 64=center 127=right"), expression: int(0, 127), mute: { type: "boolean" }, solo: { type: "boolean" }, baseRevision: BASE_REV }, ["trackId"]),
      run: (a) => {
        const t = trackOf(P(), a.trackId as string);
        const mix = Object.fromEntries(["volume", "pan", "expression", "mute", "solo"].filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
        const mode = (a.mode as string) ?? "default";
        if (mode === "clear_override") { c.setOverride(t.id, null); return { data: { cleared: t.id } }; }
        if (mode === "override") { c.setOverride(t.id, mix); return { data: { override: c.getState().overrides[t.id] } }; }
        const r = c.setTrackMixDefault(t.id, mix, "agent", a.baseRevision as number | undefined);
        const authored = P().ccs.some((e) => e.trackId === t.id && [7, 10, 11].includes(e.controller));
        return { data: { mix: trackOf(P(), t.id).mix }, warnings: [...r.warnings, ...(authored ? ["track has authored CC7/10/11 automation which overrides the mix default at its event times"] : [])] };
      } },
    { name: "gbk_set_instrument", readOnly: false, description: "Set a track's program/bank at tick 0 (undoable).", inputSchema: obj({ trackId: str(), program: int(0, 127), bankMsb: int(0, 127), bankLsb: int(0, 127), baseRevision: BASE_REV }, ["trackId", "program"]),
      run: (a) => { const t = trackOf(P(), a.trackId as string); const r = c.edit([{ op: "setProgram", trackId: t.id, program: a.program as number, bankMsb: (a.bankMsb as number) ?? 0, bankLsb: (a.bankLsb as number) ?? 0 }], { baseRevision: a.baseRevision as number | undefined, source: "agent" }); return { data: { revision: r.revision }, warnings: r.warnings }; } },
    { name: "gbk_select_passage", readOnly: false, description: "Select a range (and optionally tracks) in the shared UI selection. Does not change the revision.", inputSchema: obj({ range: RANGE, trackIds: { type: "array", items: str(), maxItems: 64 } }, ["range"]),
      run: (a) => { const p = P(); const r = rangeToTicks(p, a.range as never); const ids = ((a.trackIds as string[]) ?? []).map((x) => trackOf(p, x).id);
        const noteIds = p.notes.filter((n) => n.tick >= r.startTick && n.tick < r.endTick && (!ids.length || ids.includes(n.trackId))).map((n) => n.id);
        c.setSelection({ ...r, trackIds: ids, noteIds }); return { data: { ...r, trackIds: ids, noteCount: noteIds.length } }; } },
    { name: "gbk_propose_note_patch", readOnly: false, description: "Stage note additions/removals/updates as a proposal (no mutation until committed).", inputSchema: obj({ add: { type: "array", items: NOTE_SCHEMA, maxItems: 2000 }, remove: { type: "array", items: str(), maxItems: 2000 }, update: { type: "array", maxItems: 2000, items: obj({ id: str(), tick: int(0, 1e9), duration: int(1, 1e9), pitch: int(0, 127), velocity: int(1, 127) }, ["id"]) }, summary: str(), baseRevision: BASE_REV }),
      run: (a) => {
        const p = P(); const ops: Op[] = [];
        if (a.add) ops.push({ op: "addNotes", notes: (a.add as (Omit<Note, "id" | "channel"> & { channel?: number })[]).map((n) => { const t = trackOf(p, n.trackId); return { ...n, trackId: t.id, channel: n.channel ?? t.channel }; }) });
        if (a.remove) ops.push({ op: "removeNotes", ids: a.remove as string[] });
        if (a.update) ops.push({ op: "updateNotes", updates: a.update as never });
        const pr = c.propose(ops, { baseRevision: a.baseRevision as number | undefined, source: "agent", summary: a.summary as string | undefined });
        return { data: proposalView(pr), warnings: pr.validation.warnings };
      } },
    { name: "gbk_propose_cc_patch", readOnly: false, description: "Stage explicit CC points for one track/controller in a range (replace or merge).", inputSchema: obj({ trackId: str(), controller: int(0, 127), channel: int(0, 15), range: RANGE, mode: { type: "string", enum: ["replace", "merge"] }, points: { type: "array", maxItems: 4000, items: obj({ tick: int(0, 1e9), value: int(0, 127) }, ["tick", "value"]) }, summary: str(), baseRevision: BASE_REV }, ["trackId", "controller", "range", "points"]),
      run: (a) => { const p = P(); const t = trackOf(p, a.trackId as string); const r = rangeToTicks(p, a.range as never);
        const pr = c.propose([{ op: "setCC", trackId: t.id, channel: (a.channel as number) ?? t.channel, controller: a.controller as number, startTick: r.startTick, endTick: r.endTick, mode: (a.mode as "replace") ?? "replace", points: a.points as never }], { baseRevision: a.baseRevision as number | undefined, source: "agent", summary: a.summary as string | undefined });
        return { data: proposalView(pr), warnings: [...pr.validation.warnings, ...ccWarn(a.controller as number)] }; } },
    { name: "gbk_generate_cc_curve", readOnly: false, description: "Generate a deterministic CC curve (crescendo, decrescendo, swell, linear, smoothstep, exponential, points) over a range for one or more tracks and stage it as a proposal.", inputSchema: obj({ trackIds: { type: "array", items: str(), minItems: 1, maxItems: 64 }, controller: int(0, 127), range: RANGE, shape: { type: "string", enum: ["crescendo", "decrescendo", "swell", "linear", "smoothstep", "exponential", "points"] }, from: int(0, 127), to: int(0, 127), peak: int(0, 127), exponent: { type: "number", minimum: 0.1, maximum: 20 }, points: { type: "array", maxItems: 256, items: obj({ beatOffset: { type: "number", minimum: 0 }, value: int(0, 127) }, ["beatOffset", "value"]) }, density: obj({ unit: { type: "string", enum: ["ticks", "beats"] }, step: { type: "number", minimum: 0.001 } }, ["unit", "step"]), simplify: { type: "boolean" }, mode: { type: "string", enum: ["replace", "merge"] }, summary: str(), baseRevision: BASE_REV }, ["trackIds", "controller", "range", "shape"]),
      run: (a) => {
        const p = P(); const r = rangeToTicks(p, a.range as never);
        const d = a.density as { unit: string; step: number } | undefined;
        const stepTicks = d ? Math.max(1, Math.round(d.unit === "beats" ? d.step * p.ppq : d.step)) : undefined;
        const pts = generateCurve({ shape: a.shape as CurveShape, ...r, from: a.from as number, to: a.to as number, peak: a.peak as number, exponent: a.exponent as number, stepTicks, simplify: a.simplify as boolean,
          points: (a.points as { beatOffset: number; value: number }[] | undefined)?.map((x) => ({ tick: r.startTick + Math.round(x.beatOffset * p.ppq), value: x.value })) }, p.ppq);
        const ops: Op[] = (a.trackIds as string[]).map((id) => { const t = trackOf(p, id); return { op: "setCC", trackId: t.id, channel: t.channel, controller: a.controller as number, ...r, mode: (a.mode as "replace") ?? "replace", points: pts }; });
        const pr = c.propose(ops, { baseRevision: a.baseRevision as number | undefined, source: "agent", summary: (a.summary as string) ?? `${a.shape} CC${a.controller}` });
        return { data: { ...proposalView(pr), points: pts.length, first: pts[0], last: pts[pts.length - 1] }, warnings: [...pr.validation.warnings, ...ccWarn(a.controller as number)] };
      } },
    { name: "gbk_propose_track_patch", readOnly: false, description: "Stage track property changes (name, channel, visibility, mix defaults) or add a track.", inputSchema: obj({ updates: { type: "array", maxItems: 64, items: obj({ trackId: str(), name: str(), channel: int(0, 15), visible: { type: "boolean" }, volume: int(0, 127), pan: int(0, 127), expression: int(0, 127) }, ["trackId"]) }, addTracks: { type: "array", maxItems: 16, items: obj({ name: str(), channel: int(0, 15) }, ["name", "channel"]) }, summary: str(), baseRevision: BASE_REV }),
      run: (a) => {
        const p = P(); const ops: Op[] = [];
        for (const u of (a.updates as Record<string, never>[]) ?? []) { const t = trackOf(p, u.trackId); const mix = Object.fromEntries(["volume", "pan", "expression"].filter((k) => u[k] !== undefined).map((k) => [k, u[k]])); ops.push({ op: "updateTrack", trackId: t.id, name: u.name, channel: u.channel, visible: u.visible, mix }); }
        for (const t of (a.addTracks as { name: string; channel: number }[]) ?? []) ops.push({ op: "addTrack", ...t });
        const pr = c.propose(ops, { baseRevision: a.baseRevision as number | undefined, source: "agent", summary: a.summary as string | undefined });
        return { data: proposalView(pr), warnings: pr.validation.warnings };
      } },
    { name: "gbk_preview_proposal", readOnly: true, description: "Audition A (original) or B (candidate) over the proposal range without mutating the project. Bounded to 30 s; honors cancellation.", inputSchema: obj({ proposalId: str(), variant: { type: "string", enum: ["A", "B"] } }, ["proposalId", "variant"]),
      run: async (a, signal) => { await c.previewProposal(a.proposalId as string, a.variant as "A" | "B", signal); return { data: { previewed: a.variant } }; } },
    { name: "gbk_commit_proposal", readOnly: false, description: "Request to apply a proposal as one undoable transaction. The user must press Accept in GBK; returns USER_APPROVAL_REQUIRED if declined.", inputSchema: obj({ proposalId: str() }, ["proposalId"]),
      run: async (a, signal) => ({ data: await c.commitProposal(a.proposalId as string, { source: "agent", signal }) }) },
    { name: "gbk_discard_proposal", readOnly: false, description: "Discard a pending proposal (project unchanged).", inputSchema: obj({ proposalId: str() }, ["proposalId"]),
      run: (a) => { c.discardProposal(a.proposalId as string, "agent"); return { data: { discarded: a.proposalId } }; } },
    { name: "gbk_undo", readOnly: false, description: "Undo the last edit (same history as the user).", inputSchema: obj({}), run: () => ({ data: { undone: c.undo() } }) },
    { name: "gbk_redo", readOnly: false, description: "Redo (same history as the user).", inputSchema: obj({}), run: () => ({ data: { redone: c.redo() } }) },
    { name: "gbk_prepare_midi_export", readOnly: false, description: "Build a Standard MIDI File (tempo/meter, timed CC, bend/pressure, programs, raw events) and offer it as a browser-local download.", inputSchema: obj({ download: { type: "boolean" } }),
      run: (a) => { const { bytes, filename } = c.prepareMidiExport(); if (a.download !== false) c.host.download?.(bytes, filename); return { data: { filename, bytes: bytes.length, downloaded: a.download !== false && !!c.host.download } }; } },
    { name: "gbk_prepare_wav_export", readOnly: false, description: "Offline-render the project with the headless SF2 renderer (same engine as gbk_render_wav; no audio unlock needed). Offers a browser download unless download is false (legacy behavior); prefer gbk_render_wav for artifacts and byte transfer.", inputSchema: obj({ download: { type: "boolean" }, normalize: { type: "string", enum: ["loudness", "peak", "off"], description: "whole-file level (default loudness: -16 LUFS, <= -1 dBTP)" } }),
      run: async (a, signal) => {
        if (!c.host.renderWav) throw new WorkstationError("UNSUPPORTED", "no renderer in this runtime");
        const blob = await c.host.renderWav(c.project, signal, a.normalize as "loudness" | "peak" | "off" | undefined);
        if (signal.aborted) throw new WorkstationError("OPERATION_CANCELLED", "cancelled");
        const filename = `${c.project.name.replace(/[^\w\- .]/g, "_").slice(0, 80) || "gbk"}.wav`;
        const requested = a.download !== false && !!c.host.download && c.host.download(blob, filename) !== false;
        return { data: { filename, bytes: blob.size, downloadRequested: requested } };
      } },
  ];
}

function ccWarn(cc: number): string[] {
  const cap = CC_CAPS[cc];
  if (!cap) return [`CC${cc} is stored and exported but has no built-in effect in the GBK SF2 engine`];
  return cap.audible ? [] : [`CC${cc} (${cap.name}): ${cap.note}`];
}

export function proposalView(p: { id: string; baseRevision: number; summary: string; range: unknown; trackIds: string[]; status: string; validation: unknown }) {
  return { proposalId: p.id, baseRevision: p.baseRevision, summary: p.summary, range: p.range, trackIds: p.trackIds, status: p.status, validation: p.validation, next: "Call gbk_preview_proposal for A/B, then gbk_commit_proposal (user approves) or gbk_discard_proposal." };
}

/** Run a tool with validation + uniform result envelope + activity logging. */
export async function runTool(c: WorkstationController, tool: ToolDef, args: unknown, signal: AbortSignal): Promise<ToolResult> {
  try {
    if (signal.aborted) throw new WorkstationError("OPERATION_CANCELLED", "cancelled before start");
    const input = (args ?? {}) as Record<string, unknown>;
    validate(tool.inputSchema, input);
    const r = await tool.run(input, signal);
    if (signal.aborted) throw new WorkstationError("OPERATION_CANCELLED", "cancelled");
    c.log("agent", tool.name, true);
    return { ok: true, projectId: c.project.id, revision: c.project.revision, data: r.data, warnings: r.warnings ?? [], ...(r.content ? { content: r.content } : {}) };
  } catch (e) {
    const code = e instanceof WorkstationError ? e.code : "INTERNAL_ERROR";
    const message = e instanceof Error ? e.message : String(e);
    c.log("agent", tool.name, false, `${code}: ${message}`);
    return { ok: false, projectId: c.project.id, revision: c.project.revision, warnings: [], error: { code, message, details: e instanceof WorkstationError ? e.details : undefined } };
  }
}
