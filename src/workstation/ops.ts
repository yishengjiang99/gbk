import { validateOverride, normalizeEffects, EFFECTS_RANGES, type VoiceOverride, type EffectsParams } from "../sf2/voice-overrides.ts";
import { TRACK_COLORS, computeEndTick, newId, type CCEvent, type Note, type Project, type Section, type TempoEvent, type TimeSigEvent, type Track, type TrackMix, type TrackRole } from "./model.ts";

export type Op =
  | { op: "addNotes"; notes: Omit<Note, "id">[] }
  | { op: "removeNotes"; ids: string[] }
  | { op: "updateNotes"; updates: { id: string; tick?: number; duration?: number; pitch?: number; velocity?: number }[] }
  | { op: "setCC"; trackId: string; channel: number; controller: number; startTick: number; endTick: number; mode: "replace" | "merge"; points: { tick: number; value: number }[] }
  | { op: "removeCC"; ids: string[] }
  | { op: "updateTrack"; trackId: string; name?: string; channel?: number; visible?: boolean; mix?: Partial<TrackMix> }
  | { op: "addTrack"; name: string; channel: number; id?: string; role?: TrackRole; mix?: Partial<TrackMix>; program?: number; bankMsb?: number; bankLsb?: number }
  | { op: "setTempoMap"; events: TempoEvent[] }
  | { op: "setTimeSigMap"; events: TimeSigEvent[] }
  | { op: "setSections"; sections: Section[] }
  | { op: "setMeta"; key?: string; descriptors?: Record<string, string>; style?: string; seed?: number }
  | { op: "setProgram"; trackId: string; program: number; bankMsb: number; bankLsb: number }
  /** merge: replaces entries with the same (gen, keyLo, keyHi) and keeps the rest; replace: the list becomes `overrides`. */
  | { op: "setVoicePatch"; trackId: string; overrides: VoiceOverride[]; mode: "merge" | "replace" }
  | { op: "setEffects"; params: Partial<EffectsParams> };

export const TRACK_ROLES: TrackRole[] = ["melody", "harmony", "bass", "counterpoint", "accompaniment", "percussion", "pad", "other"];

export class WorkstationError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}

const int = (v: unknown, lo: number, hi: number, what: string) => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw new WorkstationError("INVALID_ARGUMENT", `${what} must be an integer in [${lo}, ${hi}]`);
  return v;
};

export function validateOps(p: Project, ops: Op[]): string[] {
  const warnings: string[] = [];
  const trackIds = new Set(p.tracks.map((t) => t.id));
  for (const o of ops) if (o.op === "addTrack" && o.id) trackIds.add(o.id);
  const noteIds = new Set(p.notes.map((n) => n.id));
  if (!Array.isArray(ops) || ops.length === 0) throw new WorkstationError("INVALID_ARGUMENT", "ops must be a non-empty array");
  for (const o of ops) {
    switch (o.op) {
      case "addNotes": for (const n of o.notes) {
        if (!trackIds.has(n.trackId)) throw new WorkstationError("INVALID_ARGUMENT", `unknown track ${n.trackId}`);
        int(n.channel, 0, 15, "channel"); int(n.tick, 0, 1e9, "tick"); int(n.duration, 1, 1e9, "duration"); int(n.pitch, 0, 127, "pitch"); int(n.velocity, 1, 127, "velocity");
      } break;
      case "removeNotes": for (const id of o.ids) if (!noteIds.has(id)) warnings.push(`note ${id} not found`); break;
      case "updateNotes": for (const u of o.updates) {
        if (!noteIds.has(u.id)) throw new WorkstationError("INVALID_ARGUMENT", `note ${u.id} not found`);
        if (u.tick !== undefined) int(u.tick, 0, 1e9, "tick"); if (u.duration !== undefined) int(u.duration, 1, 1e9, "duration");
        if (u.pitch !== undefined) int(u.pitch, 0, 127, "pitch"); if (u.velocity !== undefined) int(u.velocity, 1, 127, "velocity");
      } break;
      case "setCC":
        if (!trackIds.has(o.trackId)) throw new WorkstationError("INVALID_ARGUMENT", `unknown track ${o.trackId}`);
        int(o.channel, 0, 15, "channel"); int(o.controller, 0, 127, "controller");
        if (!(o.endTick >= o.startTick && o.startTick >= 0)) throw new WorkstationError("INVALID_RANGE", "endTick must be >= startTick >= 0");
        for (const pt of o.points) { int(pt.tick, o.startTick, o.endTick, "point tick"); int(pt.value, 0, 127, "value"); }
        if ([0, 32, 6, 38, 98, 99, 100, 101].includes(o.controller)) warnings.push(`CC${o.controller} is a bank/RPN/NRPN controller; editing it changes program/parameter selection`);
        if ([120, 121, 123].includes(o.controller)) warnings.push(`CC${o.controller} is a channel-mode message`);
        break;
      case "removeCC": break;
      case "updateTrack":
        if (!trackIds.has(o.trackId)) throw new WorkstationError("INVALID_ARGUMENT", `unknown track ${o.trackId}`);
        if (o.channel !== undefined) int(o.channel, 0, 15, "channel");
        if (o.mix) for (const k of ["volume", "pan", "expression"] as const) if (o.mix[k] !== undefined) int(o.mix[k], 0, 127, k);
        break;
      case "addTrack":
        int(o.channel, 0, 15, "channel");
        if (o.program !== undefined) int(o.program, 0, 127, "program");
        if (o.bankMsb !== undefined) int(o.bankMsb, 0, 127, "bankMsb"); if (o.bankLsb !== undefined) int(o.bankLsb, 0, 127, "bankLsb");
        if (o.mix) for (const k of ["volume", "pan", "expression"] as const) if (o.mix[k] !== undefined) int(o.mix[k], 0, 127, k);
        if (o.role !== undefined && !TRACK_ROLES.includes(o.role)) throw new WorkstationError("INVALID_ARGUMENT", `role must be one of ${TRACK_ROLES.join(", ")}`);
        if (o.id && p.tracks.some((t) => t.id === o.id)) throw new WorkstationError("INVALID_ARGUMENT", `track id ${o.id} already exists`);
        break;
      case "setTempoMap": {
        if (!Array.isArray(o.events) || !o.events.length || o.events.length > 1024) throw new WorkstationError("INVALID_ARGUMENT", "tempo map needs 1..1024 events");
        let last = -1;
        for (const e of o.events) {
          int(e.tick, 0, 1e9, "tempo tick"); int(e.microPerQuarter, 1, 0xffffff, "microPerQuarter");
          if (e.tick <= last) throw new WorkstationError("INVALID_ARGUMENT", "tempo events must be strictly increasing in tick");
          last = e.tick;
        }
        if (o.events[0].tick !== 0) throw new WorkstationError("INVALID_ARGUMENT", "the first tempo event must be at tick 0 (bar 1)");
        break;
      }
      case "setTimeSigMap": {
        if (!Array.isArray(o.events) || !o.events.length || o.events.length > 1024) throw new WorkstationError("INVALID_ARGUMENT", "meter map needs 1..1024 events");
        let last = -1;
        for (const e of o.events) {
          int(e.tick, 0, 1e9, "meter tick"); int(e.numerator, 1, 255, "numerator");
          if (![1, 2, 4, 8, 16, 32, 64].includes(e.denominator)) throw new WorkstationError("INVALID_ARGUMENT", "denominator must be a power of two (1..64)");
          if (e.tick <= last) throw new WorkstationError("INVALID_ARGUMENT", "meter events must be strictly increasing in tick");
          last = e.tick;
        }
        if (o.events[0].tick !== 0) throw new WorkstationError("INVALID_ARGUMENT", "the first meter event must be at tick 0 (bar 1)");
        break;
      }
      case "setSections": {
        if (!Array.isArray(o.sections) || o.sections.length > 256) throw new WorkstationError("INVALID_ARGUMENT", "at most 256 sections");
        const sorted = [...o.sections].sort((a, b) => a.startBar - b.startBar);
        for (let i = 0; i < sorted.length; i++) {
          const s = sorted[i];
          if (typeof s.name !== "string" || !s.name.trim()) throw new WorkstationError("INVALID_ARGUMENT", "section name required");
          int(s.startBar, 1, 100000, "startBar"); int(s.bars, 1, 100000, "bars");
          if (s.energy !== undefined && !(typeof s.energy === "number" && s.energy >= 0 && s.energy <= 1)) throw new WorkstationError("INVALID_ARGUMENT", "energy must be in [0, 1]");
          if (i && sorted[i - 1].startBar + sorted[i - 1].bars > s.startBar) throw new WorkstationError("INVALID_RANGE", `section "${s.name}" overlaps "${sorted[i - 1].name}"`);
        }
        break;
      }
      case "setMeta": break;
      case "setProgram":
        if (!trackIds.has(o.trackId)) throw new WorkstationError("INVALID_ARGUMENT", `unknown track ${o.trackId}`);
        int(o.program, 0, 127, "program"); int(o.bankMsb, 0, 127, "bankMsb"); int(o.bankLsb, 0, 127, "bankLsb"); break;
      case "setVoicePatch":
        if (!trackIds.has(o.trackId)) throw new WorkstationError("INVALID_ARGUMENT", `unknown track ${o.trackId}`);
        if (!Array.isArray(o.overrides) || o.overrides.length > 128) throw new WorkstationError("INVALID_ARGUMENT", "overrides must be an array of <= 128 entries");
        for (const v of o.overrides) { const err = validateOverride(v); if (err) throw new WorkstationError("INVALID_ARGUMENT", err); }
        break;
      case "setEffects":
        for (const [k, v] of Object.entries(o.params ?? {})) {
          if (k === "enabled") { if (typeof v !== "boolean") throw new WorkstationError("INVALID_ARGUMENT", "enabled must be boolean"); continue; }
          const r = EFFECTS_RANGES[k as keyof typeof EFFECTS_RANGES];
          if (!r) throw new WorkstationError("INVALID_ARGUMENT", `unknown effects parameter ${k}`);
          if (typeof v !== "number" || !(v >= r[0] && v <= r[1])) throw new WorkstationError("INVALID_ARGUMENT", `${k} must be in [${r[0]}, ${r[1]}]`);
        }
        break;
      default: throw new WorkstationError("INVALID_ARGUMENT", `unknown op ${(o as { op: string }).op}`);
    }
  }
  return warnings;
}

/** Pure: returns a new project with ops applied (revision untouched). */
export function applyOps(src: Project, ops: Op[]): Project {
  const p = structuredClone(src);
  for (const o of ops) {
    switch (o.op) {
      case "addNotes": for (const n of o.notes) p.notes.push({ ...n, id: newId("n") }); break;
      case "removeNotes": { const s = new Set(o.ids); p.notes = p.notes.filter((n) => !s.has(n.id)); break; }
      case "updateNotes": { const m = new Map(o.updates.map((u) => [u.id, u])); p.notes = p.notes.map((n) => { const u = m.get(n.id); if (!u) return n; const { id: _i, ...rest } = u; return { ...n, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) }; }); break; }
      case "setCC": {
        const inRange = (c: CCEvent) => c.trackId === o.trackId && c.channel === o.channel && c.controller === o.controller && c.tick >= o.startTick && c.tick <= o.endTick;
        if (o.mode === "replace") p.ccs = p.ccs.filter((c) => !inRange(c));
        else { const ticks = new Set(o.points.map((x) => x.tick)); p.ccs = p.ccs.filter((c) => !(inRange(c) && ticks.has(c.tick))); }
        for (const pt of o.points) p.ccs.push({ id: newId("cc"), trackId: o.trackId, channel: o.channel, controller: o.controller, tick: pt.tick, value: pt.value });
        p.ccs.sort((a, b) => a.tick - b.tick);
        break;
      }
      case "removeCC": { const s = new Set(o.ids); p.ccs = p.ccs.filter((c) => !s.has(c.id)); break; }
      case "updateTrack": p.tracks = p.tracks.map((t): Track => t.id !== o.trackId ? t : {
        ...t, ...(o.name !== undefined ? { name: o.name.slice(0, 128) } : {}), ...(o.channel !== undefined ? { channel: o.channel } : {}),
        ...(o.visible !== undefined ? { visible: o.visible } : {}), mix: { ...t.mix, ...(o.mix ?? {}) },
      }); break;
      case "setProgram": {
        const tr = p.tracks.find((t) => t.id === o.trackId)!;
        p.programs = p.programs.filter((g) => !(g.trackId === o.trackId && g.tick === 0));
        p.programs.unshift({ id: newId("pg"), trackId: o.trackId, channel: tr.channel, tick: 0, program: o.program, bankMsb: o.bankMsb, bankLsb: o.bankLsb });
        // keep bank-select CCs consistent at tick 0
        p.ccs = p.ccs.filter((c) => !(c.trackId === o.trackId && c.tick === 0 && (c.controller === 0 || c.controller === 32)));
        break;
      }
      case "setVoicePatch": {
        const sound = p.sound ?? (p.sound = { tracks: {}, effects: null });
        const key = (v: VoiceOverride) => `${v.gen}:${v.keyLo ?? ""}:${v.keyHi ?? ""}`;
        const clean = o.overrides.map((v) => ({ gen: v.gen, mode: v.mode, value: v.value, ...(v.keyLo !== undefined ? { keyLo: v.keyLo } : {}), ...(v.keyHi !== undefined ? { keyHi: v.keyHi } : {}) }));
        const next = o.mode === "replace" ? clean : [...(sound.tracks[o.trackId] ?? []).filter((v) => !clean.some((c) => key(c) === key(v))), ...clean];
        if (next.length) sound.tracks[o.trackId] = next; else delete sound.tracks[o.trackId];
        break;
      }
      case "setEffects": {
        const sound = p.sound ?? (p.sound = { tracks: {}, effects: null });
        sound.effects = normalizeEffects({ ...(sound.effects ?? {}), ...o.params });
        break;
      }
      case "addTrack": {
        const id = o.id ?? newId("trk");
        p.tracks.push({ id, name: o.name.slice(0, 128), channel: o.channel, color: TRACK_COLORS[p.tracks.length % TRACK_COLORS.length], visible: true, mix: { volume: 100, pan: 64, expression: 127, mute: false, solo: false, ...(o.mix ?? {}) }, ...(o.role ? { role: o.role } : {}) });
        if (o.program !== undefined) p.programs.unshift({ id: newId("pg"), trackId: id, channel: o.channel, tick: 0, program: o.program, bankMsb: o.bankMsb ?? 0, bankLsb: o.bankLsb ?? 0 });
        break;
      }
      case "setTempoMap": p.tempos = o.events.map((e) => ({ tick: e.tick, microPerQuarter: e.microPerQuarter })); break;
      case "setTimeSigMap": p.timeSigs = o.events.map((e) => ({ tick: e.tick, numerator: e.numerator, denominator: e.denominator })); break;
      case "setSections": p.meta = { ...(p.meta ?? {}), sections: [...o.sections].sort((a, b) => a.startBar - b.startBar).map((s) => ({ name: s.name.slice(0, 64), startBar: s.startBar, bars: s.bars, ...(s.energy !== undefined ? { energy: s.energy } : {}) })) }; break;
      case "setMeta": p.meta = { ...(p.meta ?? {}), ...(o.key !== undefined ? { key: o.key.slice(0, 32) } : {}), ...(o.style !== undefined ? { style: o.style.slice(0, 32) } : {}), ...(o.seed !== undefined ? { seed: o.seed } : {}), ...(o.descriptors ? { descriptors: { ...(p.meta?.descriptors ?? {}), ...o.descriptors } } : {}) }; break;
    }
  }
  p.notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
  p.endTick = computeEndTick(p);
  return p;
}

export function summarizeOps(ops: Op[]): string {
  return ops.map((o) => {
    switch (o.op) {
      case "addNotes": return `add ${o.notes.length} note(s)`;
      case "removeNotes": return `remove ${o.ids.length} note(s)`;
      case "updateNotes": return `modify ${o.updates.length} note(s)`;
      case "setCC": return `${o.mode} CC${o.controller} ch${o.channel + 1} ticks ${o.startTick}-${o.endTick} (${o.points.length} pts)`;
      case "removeCC": return `remove ${o.ids.length} CC event(s)`;
      case "updateTrack": return `update track ${o.trackId}`;
      case "addTrack": return `add track "${o.name}"`;
      case "setTempoMap": return `set tempo map (${o.events.length} event(s))`;
      case "setTimeSigMap": return `set meter map (${o.events.length} event(s))`;
      case "setSections": return `set ${o.sections.length} section(s)`;
      case "setMeta": return "set composition metadata";
      case "setProgram": return `set program ${o.program} (bank ${o.bankMsb}/${o.bankLsb}) on ${o.trackId}`;
      case "setVoicePatch": return `${o.mode} ${o.overrides.length} voice override(s) on ${o.trackId}`;
      case "setEffects": return `set effects ${Object.keys(o.params).join(", ")}`;
    }
  }).join("; ");
}
