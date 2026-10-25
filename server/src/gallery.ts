// Demo gallery (#72 Phase 4): pure helpers shared by the build script (scripts/gallery/build.ts) and the private
// preview route (routes/gallery.ts). Explanations are computed from the stored notes and controllers only, so
// every sentence is a fact about the actual data (no hand-written musical claims).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface GNote { trackId: string; tick: number; duration: number; pitch: number; velocity: number }
export interface GTrack { id: string; name: string; role?: string; program: number; channel: number; notes: number; controllers: number[] }
export interface GSection { name: string; startBar: number; bars: number; energy?: number }
export interface GComposition {
  title: string; key?: string; style?: string; seed?: number; ppq: number; tempoBpm: number; timeSignature: [number, number];
  bars: number; durationSec: number; noteCount: number; ccCount: number; sections: GSection[]; tracks: GTrack[]; revision: number;
}
export interface GFile { file: string; sizeBytes: number; sha256: string }
export interface GalleryDemo {
  slug: string; title: string; prompt: string; featured?: boolean;
  recipe: { create: Record<string, unknown>; edits: Record<string, unknown>[][] };
  composition: GComposition; notes: GNote[]; cc11: { trackId: string; tick: number; value: number }[];
  wav: GFile & { sampleRate: number; channels: number; bits: number; seconds: number };
  midi: GFile & { format: number; tracks: number; division: number };
  explanation: string[];
  reproducibility: { builtAt: string; server: string; serverCommit: string; soundFont: string; renderer: string; revision: number };
}
export interface GalleryManifest { generatedAt: string; demos: GalleryDemo[] }

const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
export const noteName = (p: number) => `${NAMES[p % 12]}${Math.floor(p / 12) - 1}`;

/** Factual sentences derived from the composition data. */
export function explain(c: GComposition, notes: GNote[], cc11: { trackId: string; tick: number; value: number }[]): string[] {
  const out: string[] = [];
  const [num, den] = c.timeSignature;
  const barTicks = c.ppq * num * (4 / den);
  const musicBars = notes.length ? Math.ceil(Math.max(...notes.map((n) => n.tick + n.duration)) / barTicks - 0.01) : c.bars;
  out.push(`${musicBars} bars of ${num}/${den} at ${c.tempoBpm} BPM${c.key ? ` in ${c.key}` : ""} (${c.durationSec.toFixed(1)} s), ${c.noteCount} notes on ${c.tracks.length} track${c.tracks.length === 1 ? "" : "s"}.`);
  if (c.sections.length > 1) out.push(`Sections: ${c.sections.map((s) => `${s.name} (bars ${s.startBar}–${s.startBar + s.bars - 1})`).join(", ")}.`);
  for (const t of c.tracks) {
    const ns = notes.filter((n) => n.trackId === t.id);
    if (!ns.length) { out.push(`${t.name}: no notes.`); continue; }
    const first = ns.reduce((a, b) => (b.tick < a.tick ? b : a));
    if (t.channel === 9) { out.push(`${t.name}: ${ns.length} drum hits starting in bar ${Math.floor(first.tick / barTicks) + 1}.`); continue; }
    const lo = Math.min(...ns.map((n) => n.pitch)), hi = Math.max(...ns.map((n) => n.pitch));
    const qn = ns.filter((n) => Math.abs(n.duration - c.ppq) <= c.ppq / 8).length;
    const walking = qn / ns.length > 0.6 ? `, ${Math.round((100 * qn) / ns.length)}% of them quarter notes` : "";
    out.push(`${t.name}${t.role ? ` (${t.role})` : ""}: ${ns.length} notes from ${noteName(lo)} to ${noteName(hi)}, first entry in bar ${Math.floor(first.tick / barTicks) + 1}${walking}.`);
  }
  const entries = c.tracks.filter((t) => t.channel !== 9).map((t) => ({ t, tick: Math.min(...notes.filter((n) => n.trackId === t.id).map((n) => n.tick)) })).filter((e) => Number.isFinite(e.tick));
  const staggered = new Set(entries.map((e) => e.tick)).size;
  if (entries.length > 1 && staggered === entries.length) out.push(`The ${entries.length} parts enter one after another (${entries.sort((a, b) => a.tick - b.tick).map((e) => e.t.name).join(", ")}).`);
  else if (entries.length > 1 && staggered === 1) out.push(`${entries.length === 2 ? "Both" : `All ${entries.length}`} pitched parts start together in bar 1.`);
  if (cc11.length) {
    const sorted = [...cc11].sort((a, b) => a.tick - b.tick);
    const a = sorted[0]!, b = sorted[sorted.length - 1]!;
    out.push(`Expression (CC11) has ${cc11.length} points from bar ${Math.floor(a.tick / barTicks) + 1} to bar ${Math.floor(b.tick / barTicks) + 1}, moving from ${a.value} to ${b.value}${b.value > a.value ? " (a crescendo)" : b.value < a.value ? " (a decrescendo)" : ""}.`);
  }
  return out;
}

const COLORS = ["#3a2e9e", "#2ec4b6", "#e76f51", "#f4a261", "#8338ec", "#3a86ff", "#ff006e", "#606c38"];
/** Static SVG piano roll (one colour per track), no scripts. */
export function pianoRollSvg(c: GComposition, notes: GNote[], w = 800, h = 220): string {
  if (!notes.length) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="empty piano roll"></svg>`;
  const lo = Math.min(...notes.map((n) => n.pitch)) - 1, hi = Math.max(...notes.map((n) => n.pitch)) + 1;
  const end = Math.max(...notes.map((n) => n.tick + n.duration));
  const rows = hi - lo + 1, rh = h / rows, idx = new Map(c.tracks.map((t, i) => [t.id, i]));
  const rects = notes.map((n) => `<rect x="${((n.tick / end) * w).toFixed(1)}" y="${((hi - n.pitch) * rh).toFixed(1)}" width="${Math.max(1, (n.duration / end) * w).toFixed(1)}" height="${Math.max(1, rh - 0.5).toFixed(1)}" fill="${COLORS[(idx.get(n.trackId) ?? 0) % COLORS.length]}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Piano roll of ${c.title.replace(/[<>&"]/g, "")}: ${notes.length} notes">${rects}</svg>`;
}

export const galleryDir = (dataDir: string) => join(dataDir, "gallery");
export function loadGallery(dataDir: string): GalleryManifest | null {
  const f = join(galleryDir(dataDir), "manifest.json");
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")) as GalleryManifest; } catch { return null; }
}
