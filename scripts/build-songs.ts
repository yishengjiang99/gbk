// Build-time song gallery: songs/<yyyy-mm-dd>-<slug>/song.json (+ media) -> public/songs/ (served at /gbk/songs/).
// Pure static HTML, newest first. Run by `npm run build` / `npm run dev` (gen:songs).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SongJson {
  title: string; slug: string; date: string; composer: string; description?: string; key?: string | null; tempo?: number; meter?: string; bars?: number;
  style?: string | null; seed?: number | null; durationSeconds: number; noteCount?: number; tracks?: { name: string; color: string }[];
  render?: { loudness?: { outputLufs?: number; outputTruePeakDbTP?: number } | null; peakDbFS?: number };
  files: Record<string, { name: string; bytes: number; sha256: string; url?: string; inRepo?: boolean }>;
}
const MEDIA = ["song.mid", "song.mp3", "video.mp4", "poster.png", "project.json", "song.json", "notes.md"];
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const CSS = `body{margin:0;background:#0f1115;color:#e8eaf0;font:16px/1.5 system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:24px}a{color:#4fc3f7}
.card{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:20px;background:#161a21;border-radius:10px;padding:16px;margin:18px 0}
.card video,.song video{width:100%;border-radius:6px;background:#000}.meta{color:#8a93a6;font-size:14px}.chip{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px}
h1{margin:0 0 4px}h2{margin:0}table{border-collapse:collapse}td{padding:2px 10px 2px 0;vertical-align:top}.dl a{margin-right:14px}code{font-size:12px;color:#8a93a6;word-break:break-all}
@media(max-width:800px){.card{grid-template-columns:1fr}}`;
const page = (title: string, body: string, base: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body><main><p class="meta"><a href="${base}">GBK workstation</a> · <a href="${base}songs/">Songs</a></p>${body}</main></body></html>\n`;

function metaLine(s: SongJson) {
  const l = s.render?.loudness;
  return [s.date, s.key, s.tempo && `${s.tempo} BPM`, s.meter, s.bars && `${s.bars} bars`, s.style, mmss(s.durationSeconds), l?.outputLufs != null && `${l.outputLufs.toFixed(1)} LUFS`].filter(Boolean).map(esc).join(" · ");
}
const tracks = (s: SongJson) => (s.tracks ?? []).map((t) => `<span><span class="chip" style="background:${esc(t.color)}"></span>${esc(t.name)}</span>`).join(" ");
function downloads(s: SongJson, rel: string) {
  const f = s.files; const wavUrl = f.wav?.url ?? `${rel}song.wav`;
  return `<p class="dl"><a href="${rel}video.mp4" download>MP4 (${mb(f.mp4.bytes)})</a><a href="${wavUrl}">WAV (${mb(f.wav.bytes)})</a><a href="${rel}song.mp3" download>MP3 (${mb(f.mp3.bytes)})</a><a href="${rel}song.mid" download>MIDI</a><a href="${rel}song.json">song.json</a></p>`;
}

export function loadSongs(dir = "songs"): { dir: string; song: SongJson }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/.test(d.name) && existsSync(join(dir, d.name, "song.json")))
    .map((d) => ({ dir: d.name, song: JSON.parse(readFileSync(join(dir, d.name, "song.json"), "utf8")) as SongJson }))
    .sort((a, b) => b.dir.localeCompare(a.dir)); // newest first (date-prefixed folder names)
}

export function buildSongs(src = "songs", out = "public/songs", base = "/gbk/") {
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
  const songs = loadSongs(src);
  const cards = songs.map(({ dir, song: s }) => `<article class="card" data-song="${esc(dir)}"><video controls preload="none" playsinline poster="${dir}/poster.png" src="${dir}/video.mp4"></video>
<div><h2><a href="${dir}/">${esc(s.title)}</a></h2><p class="meta">${metaLine(s)}</p><p>${esc(s.description)}</p><p class="meta">by ${esc(s.composer)}</p><p>${tracks(s)}</p>${downloads(s, `${dir}/`)}<p><a href="${base}?song=${encodeURIComponent(dir)}">Open in workstation</a></p></div></article>`).join("\n");
  writeFileSync(join(out, "index.html"), page("GBK Songs", `<h1>Songs</h1><p class="meta">Compositions made with GBK's agent tools, newest first. ${songs.length} song${songs.length === 1 ? "" : "s"}.</p>${cards || "<p>No songs yet.</p>"}`, base));
  for (const { dir, song: s } of songs) {
    const o = join(out, dir); mkdirSync(o, { recursive: true });
    for (const f of MEDIA) if (existsSync(join(src, dir, f))) copyFileSync(join(src, dir, f), join(o, f));
    const notes = existsSync(join(src, dir, "notes.md")) ? `<h3>Notes</h3><pre style="white-space:pre-wrap">${esc(readFileSync(join(src, dir, "notes.md"), "utf8"))}</pre>` : "";
    const rows = Object.values(s.files).map((f) => `<tr><td>${esc(f.name)}</td><td>${f.bytes.toLocaleString("en-US")} B</td><td><code>${esc(f.sha256)}</code></td></tr>`).join("");
    writeFileSync(join(o, "index.html"), page(`${s.title} · GBK`, `<article class="song" data-song="${esc(dir)}"><h1>${esc(s.title)}</h1><p class="meta">${metaLine(s)} · by ${esc(s.composer)}</p>
<video controls playsinline preload="metadata" poster="poster.png" src="video.mp4"></video><p>${esc(s.description)}</p><p>${tracks(s)}</p>${downloads(s, "")}
<p><a href="${base}?song=${encodeURIComponent(dir)}" data-testid="open-in-workstation">Open in workstation</a></p>${notes}<h3>Files</h3><table>${rows}</table></article>`, base));
  }
  return songs.map((x) => x.dir);
}

if (process.argv[1]?.endsWith("build-songs.ts")) console.error(`[gen:songs] ${buildSongs().length} song(s) -> public/songs/`);
