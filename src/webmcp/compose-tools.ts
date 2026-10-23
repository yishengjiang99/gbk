// Autonomous composition WebMCP tools: new projects, tracks, tempo / meter maps, song structure.
// Edits apply immediately only inside the agent-owned project of an active autonomous session; on any other
// project they become proposals that need the user's Accept (same as every other gbk_* edit).
import type { WorkstationController } from "../workstation/controller.ts";
import { WorkstationError, TRACK_ROLES, type Op } from "../workstation/ops.ts";
import { newId, type Project, type TrackRole } from "../workstation/model.ts";
import { bars, barBeatToTick, tickToSec } from "../workstation/timing.ts";
import { parseKey } from "../music/keys.ts";
import { loadSoundFont, peekSoundFont, resolveInstrument } from "../audio/soundfont-loader.ts";
import { proposalView, type ToolDef, type JsonSchema } from "./tools.ts";

const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
const int = (minimum: number, maximum: number, description?: string): JsonSchema => ({ type: "integer", minimum, maximum, ...(description ? { description } : {}) });
const str = (maxLength = 200, description?: string): JsonSchema => ({ type: "string", maxLength, ...(description ? { description } : {}) });
const num = (minimum: number, maximum: number, description?: string): JsonSchema => ({ type: "number", minimum, maximum, ...(description ? { description } : {}) });

export const TRACK_INPUT = obj({
  name: str(64), channel: int(0, 15, "0-based MIDI channel; 9 = GM percussion (channel 10). Omit to auto-assign a free channel."),
  program: int(0, 127), bankMsb: int(0, 127), bankLsb: int(0, 127), role: { type: "string", enum: TRACK_ROLES },
  volume: int(0, 127), pan: int(0, 127, "0=left 64=center 127=right"), expression: int(0, 127), id: str(64, "optional stable id"),
}, ["name"]);

export type TrackInput = { name: string; channel?: number; program?: number; bankMsb?: number; bankLsb?: number; role?: TrackRole; volume?: number; pan?: number; expression?: number; id?: string };

/** Assign channels without collisions (percussion -> 9, others skip 9). Returns ops + warnings. */
export function trackOps(p: Project, inputs: TrackInput[]): { ops: Op[]; ids: string[]; warnings: string[] } {
  const used = new Set(p.tracks.map((t) => t.channel));
  const warnings: string[] = []; const ops: Op[] = []; const ids: string[] = [];
  const sf = peekSoundFont();
  if (!sf) { void loadSoundFont().catch(() => undefined); }
  for (const t of inputs) {
    const perc = t.role === "percussion";
    let ch = t.channel;
    if (ch === undefined) {
      if (perc) ch = 9;
      else { ch = [...Array(16).keys()].find((c) => c !== 9 && !used.has(c)); if (ch === undefined) throw new WorkstationError("INVALID_ARGUMENT", "no free MIDI channel left; pass channel explicitly to share one (tracks on one channel share controller state)"); }
    } else if (used.has(ch) && ch !== 9) warnings.push(`channel ${ch + 1} is already used by another track: CC/pitch-bend state is shared on a MIDI channel`);
    if (perc && ch !== 9) warnings.push(`"${t.name}" has role percussion but channel ${ch + 1}; GM drums are on channel 10 (index 9)`);
    used.add(ch);
    const program = t.program ?? 0;
    if (sf) {
      const r = resolveInstrument(sf.sf, program, t.bankMsb ?? 0, ch, t.bankLsb ?? 0);
      if (r.warning) warnings.push(r.warning);
    } else warnings.push(`SoundFont not loaded yet: bank/program for "${t.name}" is validated when rendering`);
    const id = t.id ?? newId("trk"); ids.push(id);
    const mix = Object.fromEntries((["volume", "pan", "expression"] as const).filter((k) => t[k] !== undefined).map((k) => [k, t[k]]));
    ops.push({ op: "addTrack", id, name: t.name, channel: ch, role: t.role, mix, program, bankMsb: t.bankMsb ?? 0, bankLsb: t.bankLsb ?? 0 });
  }
  return { ops, ids, warnings };
}

/** Result for an edit: committed (autonomous session) or a pending proposal. */
export function applied(c: WorkstationController, ops: Op[], label: string, signal: AbortSignal, baseRevision?: number, extra: Record<string, unknown> = {}) {
  const r = c.agentApply(ops, { label, baseRevision, signal });
  if (r.committed) return { data: { committed: true, revision: r.revision, ...extra }, warnings: r.warnings };
  return { data: { committed: false, ...proposalView(r.proposal), ...extra, note: "This project is not an agent-owned project in an active autonomous session, so the change is a proposal the user must Accept." }, warnings: r.proposal.validation.warnings };
}

export function buildComposeTools(c: WorkstationController): ToolDef[] {
  const P = () => c.project;
  return [
    { name: "gbk_create_project", readOnly: false,
      description: "Create a new, empty composition project (no Player / Library needed) and start a scoped autonomous session: later gbk_* edits to THIS project apply without per-change approval (still undoable; the user can end the session or discard the work). The current project is checkpointed to browser storage first unless replaceCurrent is true. Existing user projects keep Accept approval.",
      inputSchema: obj({ name: str(128), tempo: num(10, 400, "BPM"), timeSignature: { type: "array", items: { type: "integer", minimum: 1, maximum: 32 }, minItems: 2, maxItems: 2, description: "[numerator, denominator]" }, key: str(32, "e.g. \"C minor\""), ppq: int(24, 32767), replaceCurrent: { type: "boolean" }, descriptors: { type: "object", description: "free-form string metadata (mood, form, ...)" } }, ["name"]),
      run: async (a) => {
        if (a.key) parseKey(a.key as string);
        const ts = a.timeSignature as [number, number] | undefined;
        if (a.descriptors && (typeof a.descriptors !== "object" || Object.values(a.descriptors as object).some((v) => typeof v !== "string") || Object.keys(a.descriptors as object).length > 32)) throw new WorkstationError("INVALID_ARGUMENT", "descriptors must be <= 32 string values");
        const r = await c.createProject({ name: a.name as string, tempo: a.tempo as number, timeSignature: ts, key: a.key as string, ppq: a.ppq as number, replaceCurrent: a.replaceCurrent as boolean, owner: "agent", descriptors: a.descriptors as Record<string, string> });
        return { data: { projectId: r.project.id, revision: r.project.revision, ppq: r.project.ppq, tempos: r.project.tempos, timeSigs: r.project.timeSigs, key: r.project.meta?.key ?? null, previousProjectId: r.previousProjectId, previousCheckpointed: r.checkpointed, session: r.session } };
      } },
    { name: "gbk_create_track", readOnly: false,
      description: "Create one track, or several atomically via `tracks`, with bank/program, role, and mix defaults (volume CC7, pan CC10, expression CC11). Channels are auto-assigned without collisions (percussion -> channel 10). Returns the track ids. Program/bank are checked against the SoundFont (substitution warnings).",
      inputSchema: { ...TRACK_INPUT, required: [], properties: { ...(TRACK_INPUT.properties as object), tracks: { type: "array", items: TRACK_INPUT, minItems: 1, maxItems: 16 }, baseRevision: int(0, Number.MAX_SAFE_INTEGER) } },
      run: (a, signal) => {
        const list = (a.tracks as TrackInput[] | undefined) ?? (a.name ? [a as unknown as TrackInput] : []);
        if (!list.length) throw new WorkstationError("INVALID_ARGUMENT", "pass name (one track) or tracks (batch)");
        if (a.tracks && a.name) throw new WorkstationError("INVALID_ARGUMENT", "pass either a single track or tracks, not both");
        const { ops, ids, warnings } = trackOps(P(), list.map(({ baseRevision: _b, ...t }: TrackInput & { baseRevision?: number }) => t));
        const r = applied(c, ops, `create ${ids.length} track(s)`, signal, a.baseRevision as number | undefined, { trackIds: ids, tracks: list.map((t, i) => ({ id: ids[i], name: t.name, channel: (ops[i] as { channel: number }).channel, program: t.program ?? 0 })) });
        return { data: r.data, warnings: [...warnings, ...(r.warnings ?? [])] };
      } },
    { name: "gbk_set_tempo_map", readOnly: false,
      description: "Replace the tempo map. events: [{bar (1-based), beat? (0-based beat within the bar), bpm}], first at bar 1. Bars follow the current meter map (set the meter first when it changes). Affects playback, MIDI export and offline WAV timing.",
      inputSchema: obj({ events: { type: "array", minItems: 1, maxItems: 1024, items: obj({ bar: int(1, 100000), beat: num(0, 64), bpm: num(10, 400) }, ["bar", "bpm"]) }, baseRevision: int(0, Number.MAX_SAFE_INTEGER) }, ["events"]),
      run: (a, signal) => {
        const p = P();
        const evs = (a.events as { bar: number; beat?: number; bpm: number }[]).map((e) => ({ tick: barBeatToTick(p, e.bar, e.beat ?? 0), microPerQuarter: Math.round(60e6 / e.bpm) })).sort((x, y) => x.tick - y.tick);
        const end = p.endTick;
        const r = applied(c, [{ op: "setTempoMap", events: evs }], `tempo map (${evs.length})`, signal, a.baseRevision as number | undefined, { events: evs });
        const q = c.project;
        return { data: { ...r.data, durationSec: +tickToSec(q, end).toFixed(3) }, warnings: r.warnings };
      } },
    { name: "gbk_set_time_signature_map", readOnly: false,
      description: "Replace the meter map: events [{bar, numerator, denominator}] (first at bar 1), e.g. 4/4, 3/4, 6/8, 2/2. Changes land on bar boundaries computed under the new map. Existing notes keep their ticks.",
      inputSchema: obj({ events: { type: "array", minItems: 1, maxItems: 1024, items: obj({ bar: int(1, 100000), numerator: int(1, 32), denominator: { type: "integer", enum: [1, 2, 4, 8, 16, 32] } }, ["bar", "numerator", "denominator"]) }, baseRevision: int(0, Number.MAX_SAFE_INTEGER) }, ["events"]),
      run: (a, signal) => {
        const p = P();
        const src = [...(a.events as { bar: number; numerator: number; denominator: number }[])].sort((x, y) => x.bar - y.bar);
        if (src[0].bar !== 1) throw new WorkstationError("INVALID_ARGUMENT", "the first meter event must be at bar 1");
        const evs: { tick: number; numerator: number; denominator: number }[] = []; let tick = 0, bar = 1, len = 0;
        for (const e of src) {
          if (e.bar === bar && evs.length) throw new WorkstationError("INVALID_ARGUMENT", `two meter events at bar ${e.bar}`);
          tick += (e.bar - bar) * len; bar = e.bar; len = ((p.ppq * 4) / e.denominator) * e.numerator;
          evs.push({ tick, numerator: e.numerator, denominator: e.denominator });
        }
        const warnings = p.notes.length ? ["existing notes keep their tick positions; bar numbers after a meter change shift accordingly"] : [];
        const r = applied(c, [{ op: "setTimeSigMap", events: evs }], `meter map (${evs.length})`, signal, a.baseRevision as number | undefined, { events: evs });
        return { data: r.data, warnings: [...warnings, ...(r.warnings ?? [])] };
      } },
    { name: "gbk_set_song_structure", readOnly: false,
      description: "Set the semantic arrangement plan: sections [{name, startBar, bars, energy 0..1}] (non-overlapping). Persisted with the project, drawn as markers in the piano roll/transport, exported as MIDI markers, and used by gbk_generate_arrangement for dynamics.",
      inputSchema: obj({ sections: { type: "array", maxItems: 256, items: obj({ name: str(64), startBar: int(1, 100000), bars: int(1, 100000), energy: num(0, 1) }, ["name", "startBar", "bars"]) }, baseRevision: int(0, Number.MAX_SAFE_INTEGER) }, ["sections"]),
      run: (a, signal) => {
        const secs = a.sections as { name: string; startBar: number; bars: number; energy?: number }[];
        const r = applied(c, [{ op: "setSections", sections: secs }], `song structure (${secs.length} sections)`, signal, a.baseRevision as number | undefined);
        const p = c.project;
        const ticks = secs.map((s) => ({ name: s.name, startTick: barBeatToTick(p, s.startBar), endTick: barBeatToTick(p, s.startBar + s.bars) }));
        return { data: { ...r.data, sections: ticks, totalBars: Math.max(0, ...secs.map((s) => s.startBar + s.bars - 1)) }, warnings: r.warnings };
      } },
    { name: "gbk_get_composition_session", readOnly: true,
      description: "The autonomous session (if any): which project it covers, expiry, and whether edits on the current project apply without approval.",
      inputSchema: obj({}),
      run: () => ({ data: { session: c.getSession(), currentProjectId: P().id, owner: P().meta?.owner ?? "user", autonomousEditsAllowed: c.autonomousAllowed(), bars: bars(P(), P().endTick).length, sections: P().meta?.sections ?? [], key: P().meta?.key ?? null } }) },
  ];
}
