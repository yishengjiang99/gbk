// Public demo gallery (#72 Phase 4; owner approved making it public on 2026-10-24). GET /chatgpt/gallery and its
// WAV/MIDI downloads. Data comes from <dataDir>/gallery, written by scripts/gallery/build.ts. Indexable, in the
// sitemap, no scripts; file paths are allow-listed (slug from the manifest + song.wav|song.mid).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.ts";
import type { FunnelStore } from "../persistence/funnel.ts";
import { galleryDir, loadGallery, pianoRollSvg, type GalleryDemo } from "../gallery.ts";
import { PAGE_CSS, footerLinks } from "./pages.ts";

const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const GM: Record<number, string> = { 0: "Acoustic Grand Piano", 6: "Harpsichord", 19: "Church Organ", 32: "Acoustic Bass", 40: "Violin", 41: "Viola", 42: "Cello", 48: "String Ensemble", 56: "Trumpet", 60: "French Horn", 71: "Clarinet", 73: "Flute" };
const FILES = { "song.wav": { type: "audio/wav", key: "wav" }, "song.mid": { type: "audio/midi", key: "midi" } } as const;
/** Plain statements where the result differs from what the title might suggest (shown under the explanation). */
const NOTES: Record<string, string> = {
  "baroque-fugue": "All four voices enter together in bar 1. This is not a textbook fugue exposition: GBK's engine does not yet stagger the subject and answer entries.",
  "game-soundtrack": "The loop seam (bar 16 back to bar 1) has not been checked for smoothness.",
};
const kb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function demoHtml(d: GalleryDemo): string {
  const c = d.composition, base = `/chatgpt/gallery/${encodeURIComponent(d.slug)}`;
  const tracks = c.tracks.map((t) => `<tr><td>${esc(t.name)}</td><td>${esc(t.role ?? "")}</td><td>${t.channel === 9 ? "Drum kit (ch 10)" : esc(GM[t.program] ?? `GM program ${t.program}`)}</td><td>${t.notes}</td><td>${t.controllers.map((x) => `CC${x}`).join(", ")}</td></tr>`).join("");
  return `<section class="demo" id="${esc(d.slug)}"><h2>${esc(d.title)}</h2>
<p><strong>Prompt:</strong> “${esc(d.prompt)}”</p>
<audio controls preload="none" src="${base}/song.wav" aria-label="Play ${esc(d.title)}"></audio>
<div class="roll">${pianoRollSvg(c, d.notes)}</div>
<h3>What's in it</h3><ul>${d.explanation.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>${NOTES[d.slug] ? `<p class="note">${esc(NOTES[d.slug]!)}</p>` : ""}
<h3>Tracks</h3><div class="tw"><table><thead><tr><th>Track</th><th>Role</th><th>Instrument</th><th>Notes</th><th>Controllers</th></tr></thead><tbody>${tracks}</tbody></table></div>
<p><a class="cta alt" href="${base}/song.wav" download>Download WAV (${kb(d.wav.sizeBytes)})</a> <a class="cta alt" href="${base}/song.mid" download>Download MIDI</a></p>
<details><summary>Recipe and reproducibility</summary><p>WAV: ${d.wav.sampleRate} Hz, ${d.wav.channels} ch, ${d.wav.bits}-bit, ${d.wav.seconds.toFixed(1)} s, sha256 <code>${esc(d.wav.sha256)}</code>.
MIDI: SMF format ${d.midi.format}, ${d.midi.tracks} tracks, ${d.midi.division} PPQ, sha256 <code>${esc(d.midi.sha256)}</code>.
Seed ${esc(String(c.seed ?? ""))}, revision ${d.reproducibility.revision}, rendered by the ${esc(d.reproducibility.renderer)} renderer (SoundFont: ${esc(d.reproducibility.soundFont)}) on ${esc(d.reproducibility.server)} at commit ${esc(d.reproducibility.serverCommit)}, ${esc(d.reproducibility.builtAt)}.</p>
<pre><code>${esc(JSON.stringify({ gbk_create_composition: d.recipe.create, gbk_edit_composition: d.recipe.edits }, null, 2))}</code></pre></details></section>`;
}

export function galleryHtml(demos: GalleryDemo[], origin = ""): string {
  const url = `${origin}/chatgpt/gallery`, desc = "Six pieces composed by GBK Composer's engine through the same tools ChatGPT uses: listen, see the piano roll, and download WAV and MIDI.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Demo gallery · GBK Composer</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${esc(url)}"><meta name="robots" content="index,follow">
<meta property="og:type" content="website"><meta property="og:title" content="GBK Composer demo gallery"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(origin)}/icon.png"><link rel="icon" type="image/png" href="/icon.png">
<style>${PAGE_CSS}
.demo{margin:36px 0;padding-top:8px;border-top:1px solid #ece3cf}audio{width:100%;margin:8px 0}
.roll{background:#fff;border:1px solid #ece3cf;border-radius:10px;overflow:hidden}.roll svg{display:block;width:100%;height:160px}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #ece3cf}
.banner{padding:10px 14px;background:#ffefd2;color:#7a4b00;border-radius:10px;font-weight:600}</style></head>
<body><header><a href="/"><img src="/icon.png" alt="" width="40" height="40">GBK Composer</a></header><main>
<h1>Demo gallery</h1>
<p class="lead">Six pieces made by GBK's own composition engine through the same tools ChatGPT uses: one create call with a fixed seed, then typed edits, then a server render. The notes, audio, and explanations all come straight from the engine's output, with nothing written or played by hand.</p>
${demos.length ? demos.map(demoHtml).join("") : "<p>No demos built yet. Run scripts/gallery/build.ts (see docs/launch/gallery.md).</p>"}
<p><a class="cta" href="/chatgpt">Compose something like this with ChatGPT</a></p></main><footer><nav>${footerLinks()}</nav></footer></body></html>`;
}

export function galleryRoutes(app: FastifyInstance, cfg: Config, funnel?: FunnelStore) {
  app.get("/chatgpt/gallery", async (_req, reply) => {
    funnel?.bump("page_view_gallery");
    const m = loadGallery(cfg.dataDir);
    return reply.type("text/html; charset=utf-8").header("cache-control", "public, max-age=300").send(galleryHtml(m?.demos ?? [], cfg.publicOrigin));
  });
  app.get("/chatgpt/gallery/:slug/:file", async (req, reply) => {
    const { slug, file } = req.params as { slug: string; file: string };
    const spec = FILES[file as keyof typeof FILES];
    const demo = loadGallery(cfg.dataDir)?.demos.find((d) => d.slug === slug);
    if (!spec || !demo || !/^[a-z0-9-]+$/.test(slug)) return reply.code(404).send({ code: "NOT_FOUND", message: "not found" });
    const path = join(galleryDir(cfg.dataDir), slug, file);
    if (!existsSync(path)) return reply.code(404).send({ code: "NOT_FOUND", message: "not found" });
    return reply.type(spec.type).header("cache-control", "public, max-age=86400")
      .header("content-disposition", `${file.endsWith(".mid") ? "attachment" : "inline"}; filename="${slug}.${file.split(".")[1]}"`).send(readFileSync(path));
  });
}
