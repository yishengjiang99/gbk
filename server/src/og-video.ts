// iMessage won't play og:audio inline, but it plays an og:video. Render the song as an H.264/AAC MP4
// (yuv420p, main profile, +faststart): a static title header over a piano roll that scrolls under a fixed
// playhead in sync with the MP3, using the feed card's bright-theme roll (VIZ constants/colors from LiveRoll).
// Frames are drawn server-side as SVG -> raw RGBA (resvg, already a dep) and piped to ffmpeg at 10 fps
// (10 fps also keeps a video track on very short songs). Cached on disk keyed by slug + revision + MP3 hash.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { buildPreview, type PianoRollPreview } from "../../src/agent/piano-roll-preview.ts";
import { VIZ, VIZ_PALETTE } from "../../src/components/social/viz-constants.ts";
import { OG_W, OG_H, type OgSong } from "./og-image.ts";

export const ogVideoEnabled = (env: NodeJS.ProcessEnv = process.env) => env.OG_VIDEO_ENABLED !== "0";
export const OGV_FPS = 10, OGV_MAX_SEC = 180, OGV_HEADER_H = 120, OGV_ROLL_H = OG_H - OGV_HEADER_H;
/** Feed card bright palette (LiveRoll DEF.light). */
export const OGV_PAL = { ...VIZ_PALETTE.light, text: VIZ_PALETTE.light.wave, sub: VIZ_PALETTE.light.bar } as const;
const inflight = new Map<string, Promise<string>>();
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const isBlack = (p: number) => [1, 3, 6, 8, 10].includes(p % 12);
const lighten = (hex: string, k: number) => { const h = hex.replace("#", ""); const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6); const c = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) || 0); return `rgb(${c.map((x) => Math.round(x + (255 - x) * k)).join(",")})`; };

const BR = [[0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]];
/** MP3 duration in seconds from frame headers (skips ID3v2); 0 when nothing parses. Pure, no ffmpeg. */
export function mp3Duration(b: Uint8Array): number {
  let i = 0, sec = 0;
  if (b.length > 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) i = 10 + ((b[6] & 127) << 21 | (b[7] & 127) << 14 | (b[8] & 127) << 7 | (b[9] & 127));
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) { i++; continue; }
    const ver = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3, bri = b[i + 2] >> 4, sri = (b[i + 2] >> 2) & 3, pad = (b[i + 2] >> 1) & 1;
    if (ver === 1 || layer === 0 || bri === 0 || bri === 15 || sri === 3) { i++; continue; }
    const v1 = ver === 3, sr = [44100, 48000, 32000][sri] / (v1 ? 1 : ver === 2 ? 2 : 4);
    const kbps = BR[v1 ? (layer === 3 ? 0 : layer === 2 ? 1 : 2) : (layer === 3 ? 3 : 2)][bri];
    const samples = layer === 3 ? 384 : layer === 2 ? 1152 : v1 ? 1152 : 576;
    const len = layer === 3 ? (Math.floor((12 * kbps * 1000) / sr) + pad) * 4 : Math.floor(((samples / 8) * kbps * 1000) / sr) + pad;
    if (len < 4) { i++; continue; }
    sec += samples / sr; i += len;
  }
  return sec;
}

export interface Rect { x: number; y: number; w: number; h: number; fill: string; opacity: number; stroke?: string }
/** Pure geometry for one roll frame at time t of a dur-second song (mirrors LiveRoll.drawRoll). */
export function rollFrame(p: PianoRollPreview, t: number, dur: number, W = OG_W, H = OGV_ROLL_H): { rows: Rect[]; notes: Rect[]; playheadX: number } {
  const ps = p.notes.map((n) => n[3]), pLo = ps.length ? Math.min(...ps) : p.lo, pHi = ps.length ? Math.max(...ps) : p.hi;
  const lo = pLo - VIZ.pitchPad, hi = Math.max(pHi + VIZ.pitchPad, lo + VIZ.minPitchSpan - 1), rh = H / (hi - lo + 1);
  const rows: Rect[] = [];
  for (let q = lo; q <= hi; q++) if (isBlack(q)) rows.push({ x: 0, y: H - (q - lo + 1) * rh, w: W, h: rh, fill: OGV_PAL.row, opacity: 1 });
  const pps = W / VIZ.windowSec, hx = W * VIZ.playheadFrac, u = dur / 1000, notes: Rect[] = [];
  for (const [tr, s, l, pitch] of p.notes) {
    const t0 = s * u, t1 = (s + l) * u, x0 = hx + (t0 - t) * pps, x1 = hx + (t1 - t) * pps;
    if (x1 < 0 || x0 > W) continue;
    const on = t0 <= t && t1 > t, col = p.tracks[tr] ?? "#90a4ae";
    notes.push({ x: x0, y: H - (pitch - lo + 1) * rh + VIZ.noteGapPx / 2, w: Math.max(VIZ.minNoteW, x1 - x0 - VIZ.noteGapPx), h: Math.max(VIZ.minNoteH, rh - VIZ.noteGapPx),
      fill: on ? lighten(col, VIZ.activeLighten) : col, opacity: on ? 1 : t1 <= t ? VIZ.pastAlpha : VIZ.upcomingAlpha, ...(on ? { stroke: OGV_PAL.head } : {}) });
  }
  return { rows, notes, playheadX: Math.round(hx) };
}

const r1 = (n: number) => n.toFixed(1);
export function rollFrameSvg(p: PianoRollPreview, t: number, dur: number, W = OG_W, H = OGV_ROLL_H): string {
  const f = rollFrame(p, t, dur, W, H), rect = (r: Rect) => `<rect x="${r1(r.x)}" y="${r1(r.y)}" width="${r1(r.w)}" height="${r1(r.h)}" fill="${r.fill}"${r.opacity < 1 ? ` opacity="${r.opacity}"` : ""}${r.stroke ? ` stroke="${r.stroke}" stroke-width="1"` : ""}/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${OGV_PAL.bg}"/>${f.rows.map(rect).join("")}${f.notes.map(rect).join("")}<rect x="${f.playheadX - 1}" y="0" width="2" height="${H}" fill="${OGV_PAL.head}"/></svg>`;
}
export function headerSvg(o: OgSong): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_W}" height="${OGV_HEADER_H}"><rect width="${OG_W}" height="${OGV_HEADER_H}" fill="#ffffff"/><rect y="${OGV_HEADER_H - 2}" width="${OG_W}" height="2" fill="${OGV_PAL.grid}"/>
<text x="40" y="62" font-family="DejaVu Sans, Noto Sans, sans-serif" font-size="44" font-weight="bold" fill="${OGV_PAL.text}">${esc(clip(o.title, 40))}</text>
<text x="40" y="100" font-family="DejaVu Sans, Noto Sans, sans-serif" font-size="24" fill="${OGV_PAL.sub}">${esc(clip(`by ${o.artist}${o.genre ? ` · ${o.genre}` : ""}`, 70))}</text>
<text x="${OG_W - 40}" y="100" text-anchor="end" font-family="DejaVu Sans, Noto Sans, sans-serif" font-size="20" fill="${OGV_PAL.sub}">GBK Composer</text></svg>`;
}
/** Frame times for a song: 10 fps, at least one frame, capped at OGV_MAX_SEC. */
export const frameTimes = (dur: number) => Array.from({ length: Math.max(1, Math.ceil(Math.min(dur, OGV_MAX_SEC) * OGV_FPS)) }, (_, i) => i / OGV_FPS);

/** Returns the cached MP4 path; renders once per (song revision, audio) and shares one render among concurrent callers. */
export function ogVideo(dir: string, o: OgSong, mp3: Uint8Array, ffmpeg = "ffmpeg"): Promise<string> {
  const key = createHash("sha1").update(`${o.slug}|${o.rev}|${o.title}|${o.artist}|${o.genre}`).update(mp3).update("v2-roll").digest("hex").slice(0, 16);
  const file = join(dir, `${o.slug.replace(/[^a-zA-Z0-9-]/g, "_")}-${key}.mp4`);
  if (existsSync(file)) return Promise.resolve(file);
  const running = inflight.get(file); if (running) return running;
  const p = new Promise<string>((resolve, reject) => {
    mkdirSync(dir, { recursive: true });
    let proj: Parameters<typeof buildPreview>[0] = {}; try { proj = JSON.parse(o.projectJson); } catch { /* empty roll */ }
    const pv = buildPreview(proj), dur = mp3Duration(mp3) || 30, times = frameTimes(dur);
    const tag = `${process.pid}-${Date.now()}`, audio = `${file}.${tag}.mp3`, header = `${file}.${tag}.png`, tmp = `${file}.${tag}.tmp.mp4`;
    writeFileSync(audio, mp3);
    writeFileSync(header, new Resvg(headerSvg(o), { font: { loadSystemFonts: true, defaultFontFamily: "DejaVu Sans" } }).render().asPng());
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", String(OGV_FPS), "-i", header,
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${OG_W}x${OGV_ROLL_H}`, "-framerate", String(OGV_FPS), "-i", "pipe:0", "-i", audio,
      "-filter_complex", "[0:v][1:v]vstack=inputs=2:shortest=1,format=yuv420p[v]", "-map", "[v]", "-map", "2:a:0",
      "-c:v", "libx264", "-profile:v", "main", "-preset", "veryfast", "-r", String(OGV_FPS), "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-t", String(times.length / OGV_FPS), "-movflags", "+faststart", "-f", "mp4", tmp];
    const cleanup = () => { rmSync(audio, { force: true }); rmSync(header, { force: true }); };
    const child = spawn(ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"] });
    let closed = false, err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
    child.stderr.on("data", (d) => { if (err.length < 4096) err += d; });
    child.stdin.on("error", () => { /* ffmpeg exited early; reported via close */ });
    child.on("error", (e) => { closed = true; clearTimeout(timer); cleanup(); rmSync(tmp, { force: true }); reject(e); });
    child.on("close", (code) => {
      if (closed) return; closed = true; clearTimeout(timer); cleanup();
      if (code !== 0 || !existsSync(tmp)) { rmSync(tmp, { force: true }); return reject(new Error(`ffmpeg exited ${code}: ${err.trim()}`)); }
      renameSync(tmp, file); resolve(file);
    });
    (async () => {
      for (const t of times) {
        if (closed || child.stdin.destroyed) return;
        const px = new Resvg(rollFrameSvg(pv, t, dur), { font: { loadSystemFonts: false } }).render().pixels;
        if (!child.stdin.write(px)) await new Promise<void>((r) => { child.stdin.once("drain", r); child.stdin.once("close", r); });
      }
      child.stdin.end();
    })().catch(() => child.kill("SIGKILL"));
  }).finally(() => inflight.delete(file));
  inflight.set(file, p);
  return p;
}
