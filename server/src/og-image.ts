// Per-song 1200x630 Open Graph card: title, artist, genre and a piano-roll motif from the song's notes.
// SVG rendered to PNG with resvg (system fonts; DejaVu/Noto on the host). Cached on disk by slug + revision.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { buildPreview } from "../../src/agent/piano-roll-preview.ts";

export const OG_W = 1200, OG_H = 630;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface OgSong { slug: string; title: string; artist: string; genre: string; projectJson: string; rev: string | number }

export function ogSvg(o: OgSong): string {
  let p: Parameters<typeof buildPreview>[0] = {}; try { p = JSON.parse(o.projectJson); } catch { /* empty roll */ }
  const pv = buildPreview(p, 600);
  const rx = 60, ry = 300, rw = OG_W - 120, rh = 250, span = Math.max(12, pv.hi - pv.lo + 1), nh = Math.max(3, Math.min(18, rh / span));
  const notes = pv.notes.map(([t, s, l, pitch]) => `<rect x="${(rx + (s / 1000) * rw).toFixed(1)}" y="${(ry + rh - ((pitch - pv.lo + 1) / span) * rh).toFixed(1)}" width="${Math.max(3, (l / 1000) * rw).toFixed(1)}" height="${nh.toFixed(1)}" rx="2" fill="${pv.tracks[t] ?? "#61a6d1"}" opacity="0.9"/>`).join("");
  const title = esc(clip(o.title, 34)), artist = esc(clip(`by ${o.artist}`, 48)), genre = o.genre ? esc(clip(o.genre.toUpperCase(), 40)) : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_W}" height="${OG_H}" viewBox="0 0 ${OG_W} ${OG_H}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f1d2a"/><stop offset="1" stop-color="#16324a"/></linearGradient></defs>
<rect width="${OG_W}" height="${OG_H}" fill="url(#g)"/>
<rect x="${rx - 10}" y="${ry - 10}" width="${rw + 20}" height="${rh + 20}" rx="14" fill="#0b1620" opacity="0.7"/>${notes}
<text x="60" y="130" font-family="DejaVu Sans, Noto Sans, sans-serif" font-size="68" font-weight="bold" fill="#e6f0f8">${title}</text>
<text x="60" y="195" font-family="DejaVu Sans, Noto Sans, sans-serif" font-size="36" fill="#93acc0">${artist}</text>
${genre ? `<text x="60" y="250" font-family="DejaVu Sans, Noto Sans, sans-serif" font-size="26" font-weight="bold" letter-spacing="3" fill="#61a6d1">${genre}</text>` : ""}
<text x="${OG_W - 60}" y="${OG_H - 22}" text-anchor="end" font-family="DejaVu Sans, Noto Sans, sans-serif" font-size="24" fill="#93acc0">GBK Composer · compose.grepawk.com</text>
</svg>`;
}

/** Returns the cached PNG path, rendering it on first request for this revision. */
export function ogImage(dir: string, o: OgSong): string {
  const key = createHash("sha1").update(`${o.slug}|${o.rev}|${o.title}|${o.artist}|${o.genre}|v1`).digest("hex").slice(0, 16);
  const file = join(dir, `${o.slug.replace(/[^a-zA-Z0-9-]/g, "_")}-${key}.png`);
  if (existsSync(file)) return file;
  mkdirSync(dir, { recursive: true });
  const png = new Resvg(ogSvg(o), { fitTo: { mode: "width", value: OG_W }, font: { loadSystemFonts: true, defaultFontFamily: "DejaVu Sans" } }).render().asPng();
  const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, png); renameSync(tmp, file);
  return file;
}
