// Validation for shared songs (used by the server before storing AND by the browser before loading: shared
// project JSON is untrusted). Rebuilds a clean Project from known fields only; throws on anything malformed.
import type { Project } from "../workstation/model.ts";

export const SHARE_LIMITS = { projectJsonBytes: 6 * 1024 * 1024, tracks: 64, notes: 200_000, events: 200_000, raw: 2000, titleChars: 120, midiBytes: 2 * 1024 * 1024, mp3Bytes: 15 * 1024 * 1024, wavBytes: 40 * 1024 * 1024 } as const;
export class ShareValidationError extends Error { code = "INVALID_PROJECT"; }

const bad = (m: string): never => { throw new ShareValidationError(m); };
const int = (v: unknown, lo: number, hi: number, path: string): number => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : bad(`${path}: expected integer ${lo}..${hi}`));
const num = (v: unknown, lo: number, hi: number, path: string): number => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : bad(`${path}: expected number ${lo}..${hi}`));
const str = (v: unknown, max: number, path: string): string => (typeof v === "string" && v.length <= max ? v : bad(`${path}: expected string <= ${max}`));
const arr = (v: unknown, max: number, path: string): unknown[] => (Array.isArray(v) ? (v.length <= max ? v : bad(`${path}: more than ${max} items`)) : bad(`${path}: expected array`));
const o = (v: unknown, path: string): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : bad(`${path}: expected object`));
const T = 2 ** 31;

export function sanitizeSharedProject(raw: unknown): Project {
  const p = o(raw, "project");
  if (p.schemaVersion !== 1) bad("project.schemaVersion: unsupported");
  const trackIds = new Set<string>();
  const tracks = arr(p.tracks, SHARE_LIMITS.tracks, "tracks").map((x, i) => {
    const t = o(x, `tracks[${i}]`); const m = o(t.mix, `tracks[${i}].mix`); const id = str(t.id, 64, `tracks[${i}].id`); trackIds.add(id);
    return { id, name: str(t.name, 64, `tracks[${i}].name`), channel: int(t.channel, 0, 15, "channel"), color: /^#[0-9a-fA-F]{3,8}$/.test(String(t.color)) ? String(t.color) : "#90a4ae", visible: t.visible !== false,
      mix: { volume: int(m.volume, 0, 127, "volume"), pan: int(m.pan, 0, 127, "pan"), expression: int(m.expression, 0, 127, "expression"), mute: m.mute === true, solo: m.solo === true },
      ...(typeof t.role === "string" && ["melody", "harmony", "bass", "counterpoint", "accompaniment", "percussion", "pad", "other"].includes(t.role) ? { role: t.role as "melody" } : {}) };
  });
  const tr = (v: unknown, path: string) => { const s = str(v, 64, path); return trackIds.has(s) ? s : bad(`${path}: unknown track`); };
  const ev = <R>(k: string, max: number, f: (e: Record<string, unknown>, path: string) => R): R[] => arr(p[k] ?? [], max, k).map((x, i) => f(o(x, `${k}[${i}]`), `${k}[${i}]`));
  const notes = ev("notes", SHARE_LIMITS.notes, (e, q) => ({ id: str(e.id, 64, q), trackId: tr(e.trackId, q), channel: int(e.channel, 0, 15, q), tick: int(e.tick, 0, T, q), duration: int(e.duration, 1, T, q), pitch: int(e.pitch, 0, 127, q), velocity: int(e.velocity, 1, 127, q) }));
  const ccs = ev("ccs", SHARE_LIMITS.events, (e, q) => ({ id: str(e.id, 64, q), trackId: tr(e.trackId, q), channel: int(e.channel, 0, 15, q), controller: int(e.controller, 0, 127, q), tick: int(e.tick, 0, T, q), value: int(e.value, 0, 127, q) }));
  const pitchBends = ev("pitchBends", SHARE_LIMITS.events, (e, q) => ({ id: str(e.id, 64, q), trackId: tr(e.trackId, q), channel: int(e.channel, 0, 15, q), tick: int(e.tick, 0, T, q), value: int(e.value, 0, 16383, q) }));
  const channelPressure = ev("channelPressure", SHARE_LIMITS.events, (e, q) => ({ id: str(e.id, 64, q), trackId: tr(e.trackId, q), channel: int(e.channel, 0, 15, q), tick: int(e.tick, 0, T, q), value: int(e.value, 0, 127, q) }));
  const polyPressure = ev("polyPressure", SHARE_LIMITS.events, (e, q) => ({ id: str(e.id, 64, q), trackId: tr(e.trackId, q), channel: int(e.channel, 0, 15, q), tick: int(e.tick, 0, T, q), pitch: int(e.pitch, 0, 127, q), value: int(e.value, 0, 127, q) }));
  const programs = ev("programs", 4096, (e, q) => ({ id: str(e.id, 64, q), trackId: tr(e.trackId, q), channel: int(e.channel, 0, 15, q), tick: int(e.tick, 0, T, q), program: int(e.program, 0, 127, q), bankMsb: int(e.bankMsb, 0, 127, q), bankLsb: int(e.bankLsb, 0, 127, q) }));
  const tempos = ev("tempos", 4096, (e, q) => ({ tick: int(e.tick, 0, T, q), microPerQuarter: int(e.microPerQuarter, 100_000, 8_000_000, q) }));
  const timeSigs = ev("timeSigs", 4096, (e, q) => ({ tick: int(e.tick, 0, T, q), numerator: int(e.numerator, 1, 32, q), denominator: [1, 2, 4, 8, 16, 32].includes(e.denominator as number) ? (e.denominator as number) : bad(`${q}.denominator`) }));
  if (!tempos.length || !timeSigs.length) bad("tempo and meter maps must not be empty");
  // raw (sysex/meta) events are dropped: never needed for playback of a shared song and the riskiest content
  let sound: Project["sound"];
  if (p.sound && typeof p.sound === "object") {
    const s = p.sound as { tracks?: unknown; effects?: unknown };
    const tracksSnd: Record<string, never[]> = {};
    for (const [k, v] of Object.entries(o(s.tracks ?? {}, "sound.tracks"))) if (trackIds.has(k)) tracksSnd[k] = arr(v, 64, "sound.tracks[]").map((x) => { const e = o(x, "override"); return { ...Object.fromEntries(Object.entries(e).filter(([, y]) => typeof y === "number" || typeof y === "string").map(([a, y]) => [a.slice(0, 32), typeof y === "string" ? y.slice(0, 32) : y])) } as never; });
    const fx = s.effects && typeof s.effects === "object" ? Object.fromEntries(Object.entries(s.effects as object).filter(([, y]) => typeof y === "number" || typeof y === "boolean").map(([a, y]) => [a.slice(0, 32), y])) : null;
    sound = { tracks: tracksSnd, effects: fx as never };
  }
  const meta = p.meta && typeof p.meta === "object" ? (p.meta as Record<string, unknown>) : {};
  const sections = Array.isArray(meta.sections) ? meta.sections.slice(0, 256).map((x, i) => { const s = o(x, `sections[${i}]`); return { name: str(s.name, 64, "section"), startBar: int(s.startBar, 1, 100000, "startBar"), bars: int(s.bars, 1, 100000, "bars"), ...(typeof s.energy === "number" ? { energy: num(s.energy, 0, 1, "energy") } : {}) }; }) : [];
  let endTick = 0; for (const n of notes) endTick = Math.max(endTick, n.tick + n.duration); for (const c of ccs) endTick = Math.max(endTick, c.tick);
  return {
    schemaVersion: 1, id: str(p.id, 64, "id"), revision: 0, name: str(p.name, SHARE_LIMITS.titleChars, "name"), ppq: int(p.ppq, 24, 32767, "ppq"), format: 1,
    tracks, notes, ccs, pitchBends, channelPressure, polyPressure, programs, tempos, timeSigs, raw: [], endTick,
    selection: { trackIds: [], startTick: 0, endTick: 0, noteIds: [] }, loop: { enabled: false, startTick: 0, endTick: 0 },
    ...(sound ? { sound } : {}),
    meta: { ...(typeof meta.key === "string" ? { key: meta.key.slice(0, 32) } : {}), sections, ...(typeof meta.style === "string" ? { style: meta.style.slice(0, 32) } : {}) },
  };
}
