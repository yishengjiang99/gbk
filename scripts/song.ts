// GBK song pipeline (headless, no clicks): recipe -> WebMCP tool calls in Chrome (no flags; window.gbkTools shim)
// -> loudness-normalized WAV + MIDI -> deterministic piano-roll MP4 (+ poster, MP3) -> songs/<date>-<slug>/.
//
//   npm run song:publish -- songs/recipes/<name>.json [--date YYYY-MM-DD] [--fps 30|60] [--out songs]
//   npm run song:video   -- songs/<dir> [--wav path/to/song.wav] [--fps 30|60] [--out video.mp4]
//   npm run song:release -- songs/<dir>        (uploads song.wav as GitHub Release asset song-<dir>)
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";

const REPO = "yishengjiang99/gbk";
type R = { ok: boolean; data: any; warnings?: string[]; error?: { code: string; message: string } };
export interface Recipe { title: string; slug?: string; composer?: string; description?: string; notes?: string; date?: string; steps: { tool: string; args?: any }[]; render?: Record<string, unknown> }

const args = process.argv.slice(2);
const flag = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
export const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "song";
const log = (...a: unknown[]) => console.error("[song]", ...a);

async function freePort(): Promise<number> { return new Promise((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); }); }

/** Start (or reuse via GBK_BASE_URL) a Vite dev server: the pipeline imports the app's own TS modules in the page. */
async function devServer(): Promise<{ base: string; stop(): void }> {
  if (process.env.GBK_BASE_URL) return { base: process.env.GBK_BASE_URL.replace(/\/?$/, "/"), stop() {} };
  const port = await freePort();
  const proc: ChildProcess = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
  const base = `http://127.0.0.1:${port}/gbk/`;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); }
  return { base, stop: () => proc.kill() };
}

async function openPage(base: string): Promise<{ browser: Browser; page: Page }> {
  // Plain Chrome, no feature flags: tools come from the in-page shim (window.gbkTools). Falls back to bundled Chromium.
  let browser: Browser;
  try { browser = await chromium.launch({ channel: process.env.GBK_CHROME_CHANNEL ?? "chrome" }); } catch { browser = await chromium.launch(); }
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  await ctx.addInitScript(() => localStorage.setItem("gbk.agentTools", "1"));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => log("pageerror", e.message));
  await page.goto(base);
  await page.waitForFunction(async () => ((await (window as any).gbkTools?.list()) ?? []).length > 40, null, { timeout: 60_000 });
  await page.getByTestId("workstation").waitFor();
  // The player may auto-load a demo song / restore autosave shortly after start; wait until the project is stable
  // so the recipe's gbk_create_project is not overwritten by a late load.
  let last = "", stable = 0;
  for (let i = 0; i < 60 && stable < 8; i++) {
    const id = await page.evaluate(async () => JSON.parse(await (window as any).gbkTools.call("gbk_get_project_summary", {})).projectId);
    stable = id === last ? stable + 1 : 0; last = id; await page.waitForTimeout(250);
  }
  return { browser, page };
}

export async function tool(page: Page, name: string, a: unknown = {}): Promise<R> {
  const out = await page.evaluate(([n, x]) => (window as any).gbkTools.call(n, x), [name, a] as const);
  return JSON.parse(out as string);
}

async function readArtifact(page: Page, artifactId: string): Promise<Uint8Array> {
  const parts: Buffer[] = []; let off = 0;
  for (;;) {
    const c = await tool(page, "gbk_read_wav_bytes", { artifactId, offset: off, length: 262144 });
    if (!c.ok) throw new Error(`read ${artifactId}: ${c.error?.message}`);
    parts.push(Buffer.from(c.data.base64, "base64")); if (c.data.eof) break; off = c.data.nextOffset;
  }
  return new Uint8Array(Buffer.concat(parts));
}

/** Replace "$track[i]" with created track ids and "$proposal" with the last proposalId. */
export function substitute(v: any, ctx: { tracks: string[]; proposal?: string }): any {
  if (typeof v === "string") { const m = /^\$track\[(\d+)\]$/.exec(v); if (m) return ctx.tracks[+m[1]]; if (v === "$proposal") return ctx.proposal; return v; }
  if (Array.isArray(v)) return v.map((x) => substitute(x, ctx));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, ctx)]));
  return v;
}

/** Draw every frame in the page (OffscreenCanvas, same drawFrame as tests) and pipe PNGs into ffmpeg with the WAV. */
export async function renderVideo(page: Page, project: unknown, wavPath: string, outMp4: string, posterPath: string | null, o: { fps: number; subtitle: string; duration: number }) {
  const mod = "/gbk/src/video/piano-roll-video.ts";
  const total: number = await page.evaluate(async ([m, p, d, s, fps]) => {
    const v = await import(/* @vite-ignore */ m as string);
    (window as any).__gbkVideo = { v, model: v.buildVideoModel(p, d, s), opts: { ...v.DEFAULT_VIDEO, fps } };
    return v.frameCount(d, fps);
  }, [mod, project, o.duration, o.subtitle, o.fps] as const);
  const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-framerate", String(o.fps), "-c:v", "png", "-i", "-", "-i", wavPath,
    "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(o.fps), "-g", String(o.fps * 2),
    "-c:a", "aac", "-b:a", "192k", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact", "-movflags", "+faststart", outMp4], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise<void>((ok, bad) => ff.on("close", (c) => (c === 0 ? ok() : bad(new Error(`ffmpeg exit ${c}`)))));
  const t0 = Date.now(); const B = 30;
  for (let i = 0; i < total; i += B) {
    const pngs: string[] = await page.evaluate(([a, b]) => { const g = (window as any).__gbkVideo; return g.v.renderPngFrames(g.model, a, b, g.opts); }, [i, Math.min(total, i + B)] as const);
    for (const p of pngs) if (!ff.stdin!.write(Buffer.from(p, "base64"))) await new Promise((r) => ff.stdin!.once("drain", r));
    if ((i / B) % 20 === 0) log(`frames ${i}/${total} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
  ff.stdin!.end(); await done;
  if (posterPath) {
    const png: string = await page.evaluate((t) => { const g = (window as any).__gbkVideo; return g.v.renderPngFrames(g.model, t, t + 1, g.opts).then((x: string[]) => x[0]); }, Math.floor(total * 0.4));
    writeFileSync(posterPath, Buffer.from(png, "base64"));
  }
  return { frames: total };
}

export function probe(file: string) {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { encoding: "utf8" }));
}

async function publish(recipePath: string) {
  const recipe: Recipe = JSON.parse(readFileSync(recipePath, "utf8"));
  const date = flag("date") ?? recipe.date ?? new Date().toISOString().slice(0, 10);
  const fps = Number(flag("fps", "30"));
  const dirName = `${date}-${recipe.slug ?? slugify(recipe.title)}`;
  const dir = resolve(flag("out", "songs")!, dirName); mkdirSync(dir, { recursive: true });
  const srv = await devServer(); const { browser, page } = await openPage(srv.base);
  try {
    const ctx: { tracks: string[]; proposal?: string } = { tracks: [] }; const callLog: unknown[] = [];
    for (const s of recipe.steps) {
      const a = substitute(s.args ?? {}, ctx); const r = await tool(page, s.tool, a);
      if (!r.ok) throw new Error(`${s.tool} failed: ${JSON.stringify(r.error)}`);
      if (s.tool === "gbk_create_track") ctx.tracks.push(...(r.data.trackIds ?? []));
      if (r.data?.proposalId) ctx.proposal = r.data.proposalId;
      callLog.push({ tool: s.tool, args: a, ok: r.ok });
      log(s.tool, "ok");
    }
    let r = await tool(page, "gbk_render_wav", { ...(recipe.render ?? {}), output: "artifact", download: false, includeMidi: true });
    if (!r.ok) throw new Error(`render failed: ${JSON.stringify(r.error)}`);
    while (r.data.status !== "completed") { await page.waitForTimeout(500); r = await tool(page, "gbk_get_render_status", { jobId: r.data.jobId }); if (["failed", "cancelled"].includes(r.data.status)) throw new Error(JSON.stringify(r)); }
    const render = r.data;
    const meta = (await tool(page, "gbk_get_render_artifact", { artifactId: render.artifactId })).data;
    const wav = await readArtifact(page, render.artifactId);
    if (sha256(wav) !== meta.sha256) throw new Error("WAV SHA-256 mismatch");
    const midiArt = (await tool(page, "gbk_list_render_artifacts", { kind: "midi", projectId: render.projectId ?? undefined })).data.artifacts[0];
    const mid = await readArtifact(page, midiArt.artifactId);
    const project = await page.evaluate(async () => { const m = await import(/* @vite-ignore */ String("/gbk/src/workstation/instance.ts")); return structuredClone(m.workstation.state.project); });
    const summary = (await tool(page, "gbk_get_project_summary")).data;
    writeFileSync(join(dir, "song.wav"), wav); writeFileSync(join(dir, "song.mid"), mid);
    writeFileSync(join(dir, "project.json"), JSON.stringify(project));
    const ts = project.timeSigs?.[0] ?? { numerator: 4, denominator: 4 }; const bpm = Math.round(60e6 / (project.tempos?.[0]?.microPerQuarter ?? 500000) * 100) / 100;
    const subtitle = [project.meta?.key, `${bpm} BPM`, `${ts.numerator}/${ts.denominator}`, recipe.composer].filter(Boolean).join(" · ");
    const v = await renderVideo(page, project, join(dir, "song.wav"), join(dir, "video.mp4"), join(dir, "poster.png"), { fps, subtitle, duration: render.durationSeconds });
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", join(dir, "song.wav"), "-c:a", "libmp3lame", "-b:a", "192k", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact", join(dir, "song.mp3")]);
    const arrangeStep = recipe.steps.find((s) => s.tool === "gbk_generate_arrangement")?.args ?? {};
    const size = (f: string) => statSync(join(dir, f)).size; const fileSha = (f: string) => sha256(readFileSync(join(dir, f)));
    const song = {
      schema: 1, title: recipe.title, slug: dirName, date, composer: recipe.composer ?? "GBK", description: recipe.description ?? "",
      key: project.meta?.key ?? null, tempo: bpm, meter: `${ts.numerator}/${ts.denominator}`, bars: summary.bars, style: project.meta?.style ?? arrangeStep.style ?? null, seed: project.meta?.seed ?? arrangeStep.seed ?? null,
      durationSeconds: render.durationSeconds, noteCount: summary.noteCount,
      instruments: render.instruments, sections: project.meta?.sections ?? [],
      tracks: project.tracks.map((t: any) => ({ name: t.name, color: t.color, role: t.role ?? null })),
      render: { sampleRate: render.sampleRate, channels: render.channels, format: render.format, peakDbFS: render.peakDbFS, rmsDbFS: render.rmsDbFS, clippedSamples: render.clippedSamples, loudness: render.loudness ?? null, normalize: (recipe.render as any)?.normalize ?? "loudness" },
      video: { width: 1920, height: 1080, fps, frames: v.frames, codec: "h264+aac" },
      files: {
        wav: { name: "song.wav", bytes: wav.length, sha256: meta.sha256, url: `https://github.com/${REPO}/releases/download/song-${dirName}/song.wav`, inRepo: false },
        mid: { name: "song.mid", bytes: size("song.mid"), sha256: fileSha("song.mid") },
        mp3: { name: "song.mp3", bytes: size("song.mp3"), sha256: fileSha("song.mp3") },
        mp4: { name: "video.mp4", bytes: size("video.mp4"), sha256: fileSha("video.mp4") },
        poster: { name: "poster.png", bytes: size("poster.png"), sha256: fileSha("poster.png") },
      },
      recipe: { steps: recipe.steps, render: recipe.render ?? {} }, toolCalls: callLog,
      generator: { gbkCommit: (() => { try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; } })() },
    };
    writeFileSync(join(dir, "song.json"), JSON.stringify(song, null, 2) + "\n");
    if (recipe.notes) writeFileSync(join(dir, "notes.md"), recipe.notes);
    log(`wrote ${dir}`); console.log(JSON.stringify({ dir, files: song.files, durationSeconds: song.durationSeconds, frames: v.frames }, null, 2));
    log(`next: git add ${flag("out", "songs")}/${dirName} && git commit -m "song: ${recipe.title}" ; npm run song:release -- ${flag("out", "songs")}/${dirName}`);
  } finally { await browser.close(); srv.stop(); }
}

async function videoOnly(dirArg: string) {
  const dir = resolve(dirArg); const fps = Number(flag("fps", "30"));
  const project = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")); const song = existsSync(join(dir, "song.json")) ? JSON.parse(readFileSync(join(dir, "song.json"), "utf8")) : {};
  const wav = resolve(flag("wav", join(dir, "song.wav"))!);
  if (!existsSync(wav)) throw new Error(`${wav} not found (download it with: gh release download song-${basename(dir)} -R ${REPO} -D ${dir})`);
  const duration = Number(probe(wav).format.duration);
  const srv = await devServer(); const { browser, page } = await openPage(srv.base);
  try {
    const out = resolve(flag("out", join(dir, "video.mp4"))!);
    const subtitle = [project.meta?.key, song.tempo && `${song.tempo} BPM`, song.meter, song.composer].filter(Boolean).join(" · ");
    const v = await renderVideo(page, project, wav, out, flag("poster") ?? null, { fps, subtitle, duration });
    console.log(JSON.stringify({ out, frames: v.frames, bytes: statSync(out).size }));
  } finally { await browser.close(); srv.stop(); }
}

function release(dirArg: string) {
  const dir = resolve(dirArg); const tag = `song-${basename(dir)}`; const song = JSON.parse(readFileSync(join(dir, "song.json"), "utf8"));
  const wav = join(dir, "song.wav"); if (sha256(readFileSync(wav)) !== song.files.wav.sha256) throw new Error("song.wav does not match song.json sha256");
  try { execFileSync("gh", ["release", "view", tag, "-R", REPO], { stdio: "ignore" }); execFileSync("gh", ["release", "upload", tag, wav, "--clobber", "-R", REPO], { stdio: "inherit" }); }
  catch { execFileSync("gh", ["release", "create", tag, wav, "-R", REPO, "--title", `${song.title} (${song.date})`, "--notes", `Lossless WAV for ${song.title}. SHA-256 ${song.files.wav.sha256}. Gallery: https://yishengjiang99.github.io/gbk/songs/${basename(dir)}/`], { stdio: "inherit" }); }
}

const [cmd, target] = args;
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("song.ts")) {
  const run = cmd === "publish" ? publish(target) : cmd === "video" ? videoOnly(target) : cmd === "release" ? Promise.resolve(release(target)) : Promise.reject(new Error("usage: song.ts publish <recipe.json> | video <songdir> | release <songdir>"));
  run.catch((e) => { console.error(e); process.exit(1); });
}
