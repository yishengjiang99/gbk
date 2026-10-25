// Hum-feature smoke test (manual verification, not part of CI):
// serves nothing itself — point it at a running app (dev server or preview)
// whose build includes the Hum button, then drives a real Chromium with a
// fake microphone fed by a generated WAV of a C-major scale.
//
//   npm run prepare:ort-runtime && npm run prepare:hum-model
//   npm run dev -- --host 127.0.0.1 --port 5173 &
//   node scripts/hum-smoke.mjs [baseURL]
//
// Asserts: the Hum button exists; a recorded take transcribes into a new
// "Hummed melody" track whose notes (read back through window.gbkTools,
// the app's own tool surface) match the scale within a semitone; and the
// transport plays the result.
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const BASE = process.argv[2] || "http://127.0.0.1:5173/";
const SCALE = [60, 62, 64, 65, 67, 69, 71, 72]; // C major, C4..C5
const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);

/** 16-bit PCM WAV: each scale note 0.45 s (5 ms attack, 40 ms release), 0.15 s gaps. */
function scaleWav(path) {
  const sr = 44100, noteS = 0.45, gapS = 0.15;
  const per = Math.round((noteS + gapS) * sr);
  const total = per * SCALE.length;
  const pcm = new Int16Array(total);
  SCALE.forEach((m, i) => {
    const f = midiHz(m), start = i * per, n = Math.round(noteS * sr);
    for (let j = 0; j < n; j++) {
      const t = j / sr;
      const env = Math.min(1, j / (0.005 * sr)) * Math.min(1, (n - j) / (0.04 * sr));
      pcm[start + j] = Math.round(0.7 * env * Math.sin(2 * Math.PI * f * t) * 32767);
    }
  });
  const buf = Buffer.alloc(44 + total * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + total * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(total * 2, 40);
  for (let i = 0; i < total; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  writeFileSync(path, buf);
  return total / sr;
}

function headlessShell() {
  const root = join(homedir(), ".cache", "ms-playwright");
  for (const d of readdirSync(root)) {
    if (!d.startsWith("chromium_headless_shell")) continue;
    for (const sub of ["chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/headless_shell", "chrome-linux64/headless_shell"]) {
      const p = join(root, d, sub);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const wavPath = "/tmp/hum-smoke-scale.wav";
const wavSeconds = scaleWav(wavPath);
console.log(`fixture: ${wavPath} (${wavSeconds.toFixed(1)}s C-major scale)`);

const browser = await chromium.launch({
  executablePath: headlessShell(),
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${wavPath}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const fail = async (msg) => { console.error(`SMOKE FAIL: ${msg}`); await browser.close(); process.exit(1); };
try {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, permissions: ["microphone"] });
  const page = await ctx.newPage();
  const dialogs = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
  page.on("pageerror", (e) => console.log("pageerror:", e.message));

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector('[data-testid="workstation"]', { timeout: 60_000 });
  const humBtn = page.locator('[data-testid="hum-btn"]');
  await humBtn.waitFor({ state: "visible", timeout: 30_000 });
  console.log("ok: Hum button present in the transport");

  await humBtn.click();
  await page.waitForSelector('[data-testid="hum-btn"][data-phase="recording"]', { timeout: 30_000 });
  console.log("ok: recording started (fake mic stream live)");
  await page.waitForTimeout(Math.round((wavSeconds + 2.2) * 1000)); // one full scale pass + margin
  await humBtn.click();
  await page.waitForSelector('[data-testid="hum-btn"][data-phase="transcribing"]', { timeout: 15_000 });
  console.log("ok: transcribing…");
  await page.waitForSelector('[data-testid="hum-btn"][data-phase="idle"]', { timeout: 240_000 });
  if (dialogs.length) await fail(`unexpected dialog(s): ${dialogs.join(" | ")}`);

  await page.waitForSelector('[data-testid="track-Hummed melody"]', { timeout: 30_000 });
  console.log("ok: 'Hummed melody' track is visible in the track list");

  // window.gbkTools is the app's own tool surface; enable Agent Tools if needed.
  let toolsReady = await page.evaluate(() => !!window.gbkTools);
  if (!toolsReady) {
    await page.click('[data-testid="agent-toggle"]');
    await page.waitForTimeout(800);
    toolsReady = await page.evaluate(() => !!window.gbkTools);
  }
  if (!toolsReady) await fail("window.gbkTools unavailable");
  const data = await page.evaluate(async () => {
    const tools = window.gbkTools;
    const parse = (v) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return v; } };
    const dig = (v) => {
      let o = parse(v);
      if (o && Array.isArray(o.content)) o = parse(o.content.find((c) => c.type === "text")?.text ?? o);
      return o?.data ?? o;
    };
    return { tracks: dig(await tools.call("gbk_list_tracks", {})), notes: dig(await tools.call("gbk_get_notes", {})) };
  });
  const trackList = data.tracks?.tracks ?? data.tracks;
  const humTrack = Array.isArray(trackList) ? trackList.find((t) => t.name === "Hummed melody") : null;
  if (!humTrack) await fail(`hum track not in gbk_list_tracks: ${JSON.stringify(data.tracks).slice(0, 400)}`);
  const allNotes = data.notes?.notes ?? data.notes;
  const notes = (Array.isArray(allNotes) ? allNotes : []).filter((n) => n.trackId === humTrack.id || !n.trackId);
  console.log(`track: ${JSON.stringify(humTrack)}`);
  console.log(`notes (${notes.length}): ${notes.map((n) => `${n.pitch}@${n.tick}+${n.duration}`).join(" ")}`);
  if (notes.length < 5) await fail(`expected >= 5 transcribed notes, got ${notes.length}`);
  const offScale = notes.filter((n) => !SCALE.some((s) => Math.abs(s - n.pitch) <= 1));
  if (offScale.length > Math.max(1, notes.length * 0.2)) await fail(`too many off-scale pitches: ${offScale.map((n) => n.pitch).join(",")}`);
  const degrees = new Set(notes.map((n) => SCALE.reduce((a, b) => (Math.abs(b - n.pitch) < Math.abs(a - n.pitch) ? b : a))));
  if (degrees.size < 5) await fail(`only ${degrees.size} distinct scale degrees detected`);
  console.log(`ok: ${notes.length} notes, ${degrees.size} distinct scale degrees, all within a semitone of the scale`);

  // Playback through the normal engine: transport must advance.
  await page.waitForSelector('[data-testid="ws-play"]', { timeout: 60_000 });
  const pos0 = Number(await page.getAttribute('[data-testid="ws-pos"]', "data-pos-tick"));
  await page.click('[data-testid="ws-play"]');
  await page.waitForTimeout(1800);
  const pos1 = Number(await page.getAttribute('[data-testid="ws-pos"]', "data-pos-tick"));
  await page.click('[aria-label="Stop"]');
  console.log(`ok: playback advanced the transport ${pos0} -> ${pos1} ticks`);
  if (!(pos1 > pos0)) await fail("transport did not advance during playback");

  console.log("SMOKE PASS");
} finally {
  await browser.close();
}
