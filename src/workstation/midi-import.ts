// Standard MIDI File upload (type 0/1) into the studio: open as a new project, or add the file's tracks to the
// current project (undoable edit ops; ticks rescaled to the project's PPQ). Parser: workstation/smf.ts.
import { parseSmf } from "./smf.ts";
import type { WorkstationController } from "./controller.ts";
import type { Op } from "./ops.ts";
import type { Project } from "./model.ts";

export const MIDI_ACCEPT = "application/json,.mid,.midi,audio/midi,audio/x-midi,audio/mid";
export const isMidiFile = (f: { name: string; type: string }) => /\.(mid|midi|smf|kar)$/i.test(f.name) || /^audio\/(x-)?midi?$/.test(f.type);
const MAX_BYTES = 8 * 1048576;

/** Parse + validate; throws a user-facing Error for unreadable / empty files. */
export function readMidi(buf: ArrayBuffer | Uint8Array, name: string): Project {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (!u.length) throw new Error("That MIDI file is empty.");
  if (u.length > MAX_BYTES) throw new Error("That MIDI file is too large (max 8 MB).");
  let p: Project;
  try { p = parseSmf(u, name.replace(/\.(mid|midi|smf|kar)$/i, "") || "Imported MIDI"); } catch (e) { throw new Error(`Not a readable MIDI file (${(e as Error).message}).`); }
  // Format 1 files often carry a notes-less conductor track (tempo/time sig only): drop such tracks.
  const used = new Set([...p.notes.map((n) => n.trackId), ...p.ccs.map((c) => c.trackId), ...p.pitchBends.map((b) => b.trackId)]);
  p.tracks = p.tracks.filter((t) => used.has(t.id));
  if (!p.notes.length) throw new Error("That MIDI file has no notes.");
  return p;
}

/** Edit ops that add every track of `src` (with notes, programs, CCs, pitch bends) to `dst`. */
export function mergeOps(dst: Project, src: Project): Op[] {
  const k = dst.ppq / src.ppq; const T = (t: number) => Math.round(t * k);
  const ops: Op[] = [];
  for (const t of src.tracks) {
    const pg = src.programs.find((p) => p.trackId === t.id);
    ops.push({ op: "addTrack", id: t.id, name: t.name, channel: t.channel, ...(pg ? { program: pg.program, bankMsb: pg.bankMsb, bankLsb: pg.bankLsb } : {}) });
    const notes = src.notes.filter((n) => n.trackId === t.id).map(({ id: _id, ...n }) => ({ ...n, tick: T(n.tick), duration: Math.max(1, T(n.duration)) }));
    if (notes.length) ops.push({ op: "addNotes", notes });
    const byCc = new Map<string, { channel: number; controller: number; points: { tick: number; value: number }[] }>();
    for (const c of src.ccs.filter((c) => c.trackId === t.id && c.controller !== 0 && c.controller !== 32)) { const key = `${c.channel}:${c.controller}`; const g = byCc.get(key) ?? { channel: c.channel, controller: c.controller, points: [] }; g.points.push({ tick: T(c.tick), value: c.value }); byCc.set(key, g); }
    for (const g of byCc.values()) ops.push({ op: "setCC", trackId: t.id, channel: g.channel, controller: g.controller, startTick: g.points[0].tick, endTick: g.points[g.points.length - 1].tick + 1, mode: "merge", points: g.points });
    const pbs = src.pitchBends.filter((b) => b.trackId === t.id);
    if (pbs.length) ops.push({ op: "addPitchBends", trackId: t.id, channel: pbs[0].channel, events: pbs.map((b) => ({ tick: T(b.tick), value: b.value })) });
  }
  return ops;
}

export async function importMidiFile(file: File, ctrl: WorkstationController, mode: "new" | "merge"): Promise<{ tracks: number; notes: number }> {
  const p = readMidi(await file.arrayBuffer(), file.name);
  if (mode === "new" || ctrl.readOnlyReason) ctrl.load(p);
  else { const r = ctrl.userEdit(mergeOps(ctrl.project, p), { label: `Import ${file.name}` }); if (!r) throw new Error("Could not add the MIDI tracks to this project."); }
  return { tracks: p.tracks.length, notes: p.notes.length };
}
