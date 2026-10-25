// Web side of the iOS native Hum bridge (docs/social/hum-bridge.md; iOS: ios/GBKComposer/Features/Create/Hum/HumBridge.swift).
// iOS records + transcribes on device, converts with HumNotesToOps.swift (port of notes-to-ops.ts humToOps) and calls
// window.gbkHum.apply(ops, { label, selectTrackId }). We validate that the ops are exactly humToOps output
// ([addTrack "Hummed melody", addNotes on that track]) and apply them as one undoable edit on a NEW track.
import type { Op } from "../workstation/ops.ts";
import type { WorkstationController } from "../workstation/controller.ts";
import { HUM_TRACK_NAME, HUM_PROGRAM } from "./notes-to-ops.ts";

export type HumPhase = "idle" | "recording" | "transcribing";
export interface HumState { phase: HumPhase; elapsed: number; progress: number }
export type HumApplyResult = { ok: true; trackId: string; notes: number; revision: number } | { ok: false; error: string };
interface Native { platform?: string; capabilities?: string[] }
export const nativeHum = () => typeof window !== "undefined" && !!(window as unknown as { gbkNative?: Native }).gbkNative?.capabilities?.includes("hum");
export const MAX_HUM_NOTES = 5000;
const int = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/** Validate iOS ops; returns normalized ops (name/program/role forced to humToOps values) or an error. */
export function validateHumOps(ops: unknown, existingTrackIds: string[]): { ops: Op[]; trackId: string } | { error: string } {
  if (!Array.isArray(ops) || ops.length !== 2) return { error: "expected [addTrack, addNotes]" };
  const [a, n] = ops as Record<string, unknown>[];
  if (a?.op !== "addTrack" || n?.op !== "addNotes") return { error: "expected [addTrack, addNotes]" };
  const id = a.id; if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return { error: "bad track id" };
  if (existingTrackIds.includes(id)) return { error: "track id already exists" };
  if (!int(a.channel, 0, 15) || a.channel === 9) return { error: "bad channel" };
  const notes = n.notes; if (!Array.isArray(notes) || !notes.length || notes.length > MAX_HUM_NOTES) return { error: `1-${MAX_HUM_NOTES} notes` };
  for (const x of notes as Record<string, unknown>[]) {
    if (!x || x.trackId !== id || x.channel !== a.channel) return { error: "notes must be on the new track" };
    if (!int(x.tick, 0, 1e9) || !int(x.duration, 1, 1e8) || !int(x.pitch, 0, 127) || !int(x.velocity, 1, 127)) return { error: "bad note" };
  }
  const ch = a.channel as number;
  return { trackId: id, ops: [
    { op: "addTrack", id, name: HUM_TRACK_NAME, channel: ch, program: HUM_PROGRAM, bankMsb: 0, bankLsb: 0, role: "melody" },
    { op: "addNotes", notes: (notes as { tick: number; duration: number; pitch: number; velocity: number }[]).map((x) => ({ trackId: id, channel: ch, tick: x.tick, duration: x.duration, pitch: x.pitch, velocity: x.velocity })) },
  ] };
}

export function installHumBridge(ws: WorkstationController) {
  const api = {
    context: () => ({ ppq: ws.project.ppq, tempos: ws.project.tempos.map((t) => ({ tick: t.tick, microPerQuarter: t.microPerQuarter })), tracks: ws.project.tracks.map((t) => ({ channel: t.channel })), readOnlyReason: ws.readOnlyReason ?? null }),
    apply: (ops: unknown, opts?: { label?: string; selectTrackId?: string }): HumApplyResult => {
      if (ws.readOnlyReason) { for (const f of ws.readOnlyHintListeners) f(ws.readOnlyReason); return { ok: false, error: ws.readOnlyReason }; }
      const v = validateHumOps(ops, ws.project.tracks.map((t) => t.id)); if ("error" in v) return { ok: false, error: v.error };
      const r = ws.userEdit(v.ops, { label: typeof opts?.label === "string" ? opts.label.slice(0, 80) : "hum a melody" });
      if (!r) return { ok: false, error: "the studio could not add the track" };
      ws.setSelection({ trackIds: [v.trackId], noteIds: [] });
      return { ok: true, trackId: v.trackId, notes: (v.ops[1] as { notes: unknown[] }).notes.length, revision: r.revision };
    },
    showReadOnlyHint: (reason: unknown) => { for (const f of ws.readOnlyHintListeners) f(String(reason ?? ws.readOnlyReason ?? "")); },
    onState: (s: Partial<HumState>) => { window.dispatchEvent(new CustomEvent<HumState>("gbk:hum-state", { detail: { phase: s.phase === "recording" || s.phase === "transcribing" ? s.phase : "idle", elapsed: Number(s.elapsed) || 0, progress: Number(s.progress) || 0 } })); },
  };
  (window as unknown as { gbkHum: typeof api }).gbkHum = api;
  return api;
}
