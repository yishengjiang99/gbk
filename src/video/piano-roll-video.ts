// Deterministic song-video frames: a scrolling piano roll driven only by (project, time). No clocks, no randomness,
// no audio: frame i always shows time i / fps, so the video is in sync with a WAV that starts at t = 0.
import type { Project } from "../workstation/model.ts";
import { tickToSec, tempoSegments, bars as barList, barBeatToTick } from "../workstation/timing.ts";

export interface VideoNote { t0: number; t1: number; pitch: number; velocity: number; track: number }
export interface VideoModel {
  title: string; subtitle: string; duration: number;
  tracks: { name: string; color: string }[];
  notes: VideoNote[];            // sorted by t0
  sections: { name: string; t: number }[];
  barTimes: number[];            // bar start times (s)
  pitchLo: number; pitchHi: number;
}
export interface VideoOptions { width: number; height: number; fps: number; windowSeconds: number; playheadFrac: number }
export const DEFAULT_VIDEO: VideoOptions = { width: 1920, height: 1080, fps: 30, windowSeconds: 8, playheadFrac: 0.3 };

/** Build the time-domain model from a project. `duration` is the audio length (WAV incl. tail) so frames == audio. */
export function buildVideoModel(p: Project, duration: number, subtitle = ""): VideoModel {
  const segs = tempoSegments(p.tempos, p.ppq);
  const sec = (tick: number) => tickToSec(p, tick, segs);
  const idx = new Map(p.tracks.map((t, i) => [t.id, i]));
  const notes = p.notes.filter((n) => idx.has(n.trackId)).map((n) => ({ t0: sec(n.tick), t1: sec(n.tick + n.duration), pitch: n.pitch, velocity: n.velocity, track: idx.get(n.trackId)! }))
    .sort((a, b) => a.t0 - b.t0 || a.pitch - b.pitch || a.track - b.track);
  const pitches = notes.map((n) => n.pitch);
  const lo = pitches.length ? Math.min(...pitches) : 48, hi = pitches.length ? Math.max(...pitches) : 72;
  const endTick = Math.max(p.endTick ?? 0, ...p.notes.map((n) => n.tick + n.duration));
  return {
    title: p.name, subtitle, duration,
    tracks: p.tracks.map((t) => ({ name: t.name, color: t.color })),
    notes,
    sections: (p.meta?.sections ?? []).map((s) => ({ name: s.name, t: sec(barBeatToTick(p, s.startBar)) })),
    barTimes: barList(p, endTick).map((b) => sec(b.tick)),
    pitchLo: Math.max(0, lo - 3), pitchHi: Math.min(127, hi + 3),
  };
}

export const frameCount = (duration: number, fps: number) => Math.ceil(duration * fps - 1e-9);
export const frameTime = (i: number, fps: number) => i / fps;
/** Notes sounding at time t (onset inclusive, release exclusive). */
export const activeNotes = (m: VideoModel, t: number) => m.notes.filter((n) => n.t0 <= t + 1e-9 && n.t1 > t);
export const sectionAt = (m: VideoModel, t: number) => [...m.sections].reverse().find((s) => s.t <= t + 1e-9) ?? null;

const BG = "#0f1115", GRID = "#1c2028", BAR = "#2a3040", TEXT = "#e8eaf0", DIM = "#8a93a6";
export const KEYBOARD_W = 90;
const isBlack = (p: number) => [1, 3, 6, 8, 10].includes(p % 12);

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export function drawFrame(ctx: Ctx, m: VideoModel, t: number, o: VideoOptions = DEFAULT_VIDEO) {
  const { width: W, height: H } = o;
  const top = 150, bottom = H - 70, rollH = bottom - top;
  const rows = m.pitchHi - m.pitchLo + 1, rowH = rollH / rows;
  const pxPerSec = (W - KEYBOARD_W) / o.windowSeconds;
  const headX = KEYBOARD_W + (W - KEYBOARD_W) * o.playheadFrac;
  const x = (s: number) => headX + (s - t) * pxPerSec;
  const y = (pitch: number) => bottom - (pitch - m.pitchLo + 1) * rowH;
  ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
  for (let pch = m.pitchLo; pch <= m.pitchHi; pch++) if (isBlack(pch)) { ctx.fillStyle = "#13161c"; ctx.fillRect(KEYBOARD_W, y(pch), W, rowH); }
  // bar lines + section bands
  for (const [i, bt] of m.barTimes.entries()) { const bx = x(bt); if (bx < KEYBOARD_W || bx > W) continue; ctx.fillStyle = i % 4 === 0 ? BAR : GRID; ctx.fillRect(Math.round(bx), top, 1, rollH); }
  ctx.textBaseline = "top";
  for (const s of m.sections) { const sx = x(s.t); if (sx > W || sx < KEYBOARD_W - 400) continue; ctx.fillStyle = "#ffd54f"; ctx.fillRect(Math.round(sx), top - 34, 2, rollH + 34); ctx.font = "600 22px sans-serif"; ctx.fillText(s.name, Math.round(sx) + 8, top - 32); }
  // notes
  const lit = new Map<number, string>();
  for (const n of m.notes) {
    const x0 = x(n.t0), x1 = x(n.t1);
    if (x1 < KEYBOARD_W || x0 > W) continue;
    const on = n.t0 <= t + 1e-9 && n.t1 > t;
    const color = m.tracks[n.track]?.color ?? "#ccc";
    ctx.globalAlpha = on ? 1 : n.t1 <= t ? 0.35 : 0.75;
    ctx.fillStyle = color;
    const nx = Math.max(KEYBOARD_W, x0);
    ctx.fillRect(nx, y(n.pitch) + 1, Math.max(2, x1 - nx - 1), Math.max(2, rowH - 2));
    if (on) { ctx.globalAlpha = 1; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2; ctx.strokeRect(nx, y(n.pitch) + 1, Math.max(2, x1 - nx - 1), Math.max(2, rowH - 2)); lit.set(n.pitch, color); }
  }
  ctx.globalAlpha = 1;
  // keyboard (lit keys in track color)
  for (let pch = m.pitchLo; pch <= m.pitchHi; pch++) { ctx.fillStyle = lit.get(pch) ?? (isBlack(pch) ? "#222" : "#ddd"); ctx.fillRect(0, y(pch), KEYBOARD_W - 4, rowH - 1); }
  ctx.fillStyle = "#ffffff"; ctx.fillRect(Math.round(headX) - 1, top, 2, rollH);
  // header
  ctx.fillStyle = TEXT; ctx.font = "700 48px sans-serif"; ctx.fillText(m.title, 40, 28);
  ctx.fillStyle = DIM; ctx.font = "400 24px sans-serif"; ctx.fillText(m.subtitle, 40, 88);
  const sec = sectionAt(m, t);
  ctx.textAlign = "right"; ctx.fillStyle = "#ffd54f"; ctx.font = "600 30px sans-serif"; ctx.fillText(sec?.name ?? "", W - 40, 32);
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  ctx.fillStyle = DIM; ctx.font = "400 24px monospace"; ctx.fillText(`${mmss(t)} / ${mmss(m.duration)}`, W - 40, 80); ctx.textAlign = "left";
  // legend + progress
  let lx = 40; ctx.font = "500 22px sans-serif"; ctx.textBaseline = "middle";
  for (const tr of m.tracks) { ctx.fillStyle = tr.color; ctx.fillRect(lx, H - 40, 18, 18); ctx.fillStyle = TEXT; ctx.fillText(tr.name, lx + 26, H - 31); lx += 40 + ctx.measureText(tr.name).width; }
  ctx.fillStyle = GRID; ctx.fillRect(0, H - 6, W, 6); ctx.fillStyle = "#4fc3f7"; ctx.fillRect(0, H - 6, W * Math.min(1, t / m.duration), 6);
  ctx.textBaseline = "alphabetic";
}

/** In-browser helper used by scripts/song.ts: render frames [from, to) as PNG base64 strings. */
export async function renderPngFrames(m: VideoModel, from: number, to: number, o: VideoOptions = DEFAULT_VIDEO): Promise<string[]> {
  const c = new OffscreenCanvas(o.width, o.height); const ctx = c.getContext("2d")!;
  const out: string[] = [];
  for (let i = from; i < to; i++) {
    drawFrame(ctx, m, frameTime(i, o.fps), o);
    const buf = new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
    let s = ""; for (let k = 0; k < buf.length; k += 0x8000) s += String.fromCharCode(...buf.subarray(k, k + 0x8000));
    out.push(btoa(s));
  }
  return out;
}
