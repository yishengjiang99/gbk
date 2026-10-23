import { computeEndTick, newId, type CCEvent, type Note, type Project, type Track, type TrackMix } from "./model.ts";

export type Op =
  | { op: "addNotes"; notes: Omit<Note, "id">[] }
  | { op: "removeNotes"; ids: string[] }
  | { op: "updateNotes"; updates: { id: string; tick?: number; duration?: number; pitch?: number; velocity?: number }[] }
  | { op: "setCC"; trackId: string; channel: number; controller: number; startTick: number; endTick: number; mode: "replace" | "merge"; points: { tick: number; value: number }[] }
  | { op: "removeCC"; ids: string[] }
  | { op: "updateTrack"; trackId: string; name?: string; channel?: number; visible?: boolean; mix?: Partial<TrackMix> }
  | { op: "addTrack"; name: string; channel: number }
  | { op: "setProgram"; trackId: string; program: number; bankMsb: number; bankLsb: number };

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
      case "addTrack": int(o.channel, 0, 15, "channel"); break;
      case "setProgram":
        if (!trackIds.has(o.trackId)) throw new WorkstationError("INVALID_ARGUMENT", `unknown track ${o.trackId}`);
        int(o.program, 0, 127, "program"); int(o.bankMsb, 0, 127, "bankMsb"); int(o.bankLsb, 0, 127, "bankLsb"); break;
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
      case "addTrack": p.tracks.push({ id: newId("trk"), name: o.name.slice(0, 128), channel: o.channel, color: "#ccc", visible: true, mix: { volume: 100, pan: 64, expression: 127, mute: false, solo: false } }); break;
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
      case "setProgram": return `set program ${o.program} (bank ${o.bankMsb}/${o.bankLsb}) on ${o.trackId}`;
    }
  }).join("; ");
}
