// No-intervention end-to-end: a fresh Chrome profile, the real WebMCP API (document.modelContext), no clicks, no
// Player / Library, no SoundFont upload, no audio-unlock gesture. The only precondition is the user's existing
// opt-in to expose agent tools ("Enable Agent Tools", persisted in localStorage), set before the page loads.
import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { parseWavHeader, validateWav } from "../../src/audio/audio-validation.ts";
import { parseSmf } from "../../src/workstation/smf.ts";

const SHOTS = process.env.GBK_SHOTS ?? "/workspace/shots";
type R = { ok: boolean; revision: number; projectId: string; data: any; warnings: string[]; error?: { code: string; message: string } };

async function tool(page: Page, name: string, args: object = {}): Promise<R> {
  const out = await page.evaluate(async ([n, a]) => {
    const mc = (document as any).modelContext;
    const t = (await mc.getTools()).find((x: any) => x.name === n);
    if (!t) throw new Error(`tool ${n} not registered`);
    return await mc.executeTool(t, a);
  }, [name, args] as const);
  return JSON.parse(out as string);
}

async function freshPage(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("gbk.agentTools", "1"); // user's prior opt-in (not a click)
    const w = window as any; w.__audio = { created: 0, resumed: 0 };
    for (const k of ["AudioContext", "webkitAudioContext"]) {
      const C = w[k]; if (!C) continue;
      w[k] = class extends C { constructor(...a: any[]) { super(...a); w.__audio.created++; } resume() { w.__audio.resumed++; return super.resume(); } };
    }
  });
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.goto("/gbk/");
  await expect(page.getByTestId("workstation")).toBeVisible();
  await expect.poll(async () => page.evaluate(async () => ((await (document as any).modelContext?.getTools()) ?? []).length), { timeout: 20_000 }).toBeGreaterThan(40);
}

test("Midnight Invention: compose from scratch and render a validated WAV with no human interaction", async ({ page }) => {
  test.setTimeout(600_000);
  mkdirSync(SHOTS, { recursive: true });
  await freshPage(page);
  const names: string[] = await page.evaluate(async () => (await (document as any).modelContext.getTools()).map((t: any) => t.name));
  expect(names).toEqual(expect.arrayContaining(["gbk_create_project", "gbk_create_track", "gbk_set_tempo_map", "gbk_set_time_signature_map", "gbk_set_song_structure", "gbk_generate_arrangement", "gbk_render_wav", "gbk_get_render_status", "gbk_list_render_artifacts", "gbk_get_render_artifact", "gbk_download_render_artifact", "gbk_read_wav_bytes"]));

  const proj = await tool(page, "gbk_create_project", { name: "Midnight Invention", tempo: 108, timeSignature: [4, 4], key: "C minor", ppq: 480, replaceCurrent: false });
  expect(proj.ok, JSON.stringify(proj.error)).toBe(true);
  const projectId = proj.data.projectId;
  const ids: string[] = [];
  for (const t of [{ name: "Violin", program: 40, role: "melody", pan: 40 }, { name: "Viola", program: 41, role: "harmony", pan: 56 }, { name: "Cello", program: 42, role: "bass", pan: 84 }, { name: "Harpsichord", program: 6, role: "accompaniment", pan: 64, volume: 92 }]) {
    const r = await tool(page, "gbk_create_track", t);
    expect(r.ok && r.data.committed, JSON.stringify(r)).toBe(true);
    ids.push(r.data.trackIds[0]);
  }
  expect((await tool(page, "gbk_set_tempo_map", { events: [{ bar: 1, bpm: 108 }] })).ok).toBe(true);
  expect((await tool(page, "gbk_set_time_signature_map", { events: [{ bar: 1, numerator: 4, denominator: 4 }] })).ok).toBe(true);
  expect((await tool(page, "gbk_set_song_structure", { sections: [{ name: "Introduction", startBar: 1, bars: 4, energy: 0.3 }, { name: "Theme", startBar: 5, bars: 12, energy: 0.7 }, { name: "Development", startBar: 17, bars: 12, energy: 0.95 }, { name: "Coda", startBar: 29, bars: 4, energy: 0.5 }] })).ok).toBe(true);
  const arr = await tool(page, "gbk_generate_arrangement", { style: "baroque", key: "C minor", tempo: 108, bars: 32, seed: 12345, voices: 4, complexity: 4, instrumentation: ["violin", "viola", "cello", "harpsichord"], features: { counterpoint: true, dynamicExpression: true, articulation: true, cadences: true } });
  expect(arr.ok, JSON.stringify(arr.error)).toBe(true);
  expect(arr.data.committed).toBe(true);
  console.log("arrangement", JSON.stringify({ totalNotes: arr.data.totalNotes, totalCcs: arr.data.totalCcs, metrics: arr.data.metrics, tracks: arr.data.tracks }));
  const curve = await tool(page, "gbk_generate_cc_curve", { trackIds: ids.slice(0, 3), controller: 11, shape: "decrescendo", from: 110, to: 45, range: { unit: "bars", start: 29, end: 32 } });
  expect(curve.ok).toBe(true);
  const committed = await tool(page, "gbk_commit_proposal", { proposalId: curve.data.proposalId }); // autonomous session: no Accept dialog
  expect(committed.ok, JSON.stringify(committed.error)).toBe(true);

  const tracks = (await tool(page, "gbk_list_tracks")).data as any[];
  expect(tracks.length).toBe(4);
  for (const t of tracks) { expect(t.notes).toBeGreaterThan(40); expect(t.mix.mute).toBe(false); }
  expect(tracks.map((t) => t.program.program)).toEqual([40, 41, 42, 6]);
  const summary = (await tool(page, "gbk_get_project_summary")).data;
  expect(summary.noteCount).toBeGreaterThan(400);
  expect(summary.bars).toBeGreaterThanOrEqual(32);
  expect((await tool(page, "gbk_get_cc_events", { trackId: ids[0], controller: 11 })).data.total).toBeGreaterThan(50);
  await page.screenshot({ path: `${SHOTS}/gbk-midnight-01-composed.png` });

  const midi = await tool(page, "gbk_prepare_midi_export", { download: false });
  expect(midi.ok && midi.data.downloaded === false).toBe(true);

  const t0 = Date.now();
  let r = await tool(page, "gbk_render_wav", { sampleRate: 44100, channels: 2, format: "pcm16", tailSeconds: 3, normalize: false, saveArtifact: true, download: false, output: "artifact" });
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  if (r.data.status !== "completed") {
    for (let i = 0; i < 600 && r.data.status !== "completed"; i++) { await page.waitForTimeout(500); r = await tool(page, "gbk_get_render_status", { jobId: r.data.jobId }); expect(["failed", "cancelled"]).not.toContain(r.data.status); }
  }
  console.log("render", JSON.stringify({ ms: Date.now() - t0, ...r.data, instruments: undefined }));
  expect(r.data.validated).toBe(true);
  expect(r.data.instruments.map((i: any) => [i.program, i.substituted, i.muted])).toEqual([[40, false, false], [41, false, false], [42, false, false], [6, false, false]]);
  const expectedDur = 32 * 4 * 60 / 108 + 3;
  expect(Math.abs(r.data.durationSeconds - expectedDur)).toBeLessThan(0.01);
  expect(r.data.clippedSamples).toBe(0);
  const audio = await page.evaluate(() => (window as any).__audio);
  expect(audio.resumed).toBe(0); // no audio unlock happened
  await expect(page.getByTestId(`artifact-${r.data.artifactId}`)).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: `${SHOTS}/gbk-midnight-02-rendered.png` });

  // Full WAV via bounded chunks (the agent byte-transfer path), SHA-256 + parse.
  const meta = await tool(page, "gbk_get_render_artifact", { artifactId: r.data.artifactId });
  expect(meta.ok).toBe(true);
  const parts: Buffer[] = []; let off = 0;
  for (;;) { const c = await tool(page, "gbk_read_wav_bytes", { artifactId: r.data.artifactId, offset: off, length: 262144 }); expect(c.ok).toBe(true); parts.push(Buffer.from(c.data.base64, "base64")); if (c.data.eof) break; off = c.data.nextOffset; }
  const wav = Buffer.concat(parts);
  expect(wav.length).toBe(meta.data.bytes);
  expect(createHash("sha256").update(wav).digest("hex")).toBe(meta.data.sha256);
  writeFileSync(`${SHOTS}/gbk-midnight-invention.wav`, wav);
  const h = parseWavHeader(new Uint8Array(wav));
  expect([h.container, h.sampleRate, h.channels, h.bitsPerSample]).toEqual(["RIFF", 44100, 2, 16]);
  const v = await validateWav(new Uint8Array(wav), { sampleRate: 44100, channels: 2, durationSeconds: expectedDur, toleranceSeconds: 0.01 });
  const secDb = (a: number, b: number) => { const w = v.stats.windowRmsDbFS.slice(Math.round(a / 0.1), Math.round(b / 0.1)); return w.reduce((s, x) => s + x, 0) / w.length; };
  const barSec = 4 * 60 / 108;
  const intro = secDb(0, 4 * barSec), dev = secDb(16 * barSec, 28 * barSec), tail = secDb(32 * barSec + 0.2, 32 * barSec + 1.5);
  console.log("wav", JSON.stringify({ bytes: wav.length, sha256: meta.data.sha256, peakDbFS: v.stats.peakDbFS, rmsDbFS: v.stats.rmsDbFS, introRms: intro, developmentRms: dev, tailRms: tail, lastAudibleSec: v.stats.lastAudibleSec }));
  expect(dev - intro).toBeGreaterThan(3); // section energy -> CC11 / velocity dynamics audible in PCM
  // Music reaches the final bar and decays naturally inside the rendered tail (never cut at the file end).
  expect(v.stats.lastAudibleSec!).toBeGreaterThan(31 * barSec);
  expect(v.stats.lastAudibleSec!).toBeLessThan(expectedDur - 1);
  expect(tail).toBeLessThan(-60);

  // MIDI artifact contains the generated notes, tempo and CCs.
  const midiArt = (await tool(page, "gbk_list_render_artifacts", { kind: "midi", projectId })).data.artifacts[0];
  const mparts: Buffer[] = []; let mo = 0;
  for (;;) { const c = await tool(page, "gbk_read_wav_bytes", { artifactId: midiArt.artifactId, offset: mo, length: 262144 }); mparts.push(Buffer.from(c.data.base64, "base64")); if (c.data.eof) break; mo = c.data.nextOffset; }
  const sm = parseSmf(Buffer.concat(mparts));
  expect(sm.notes.length).toBe(summary.noteCount);
  expect(sm.tempos[0].microPerQuarter).toBe(Math.round(60e6 / 108));
  expect(sm.ccs.filter((x) => x.controller === 11).length).toBeGreaterThan(100);

  // Downloadable (artifact download tool; the panel link is a real <a download>).
  const [dl] = await Promise.all([page.waitForEvent("download"), tool(page, "gbk_download_render_artifact", { artifactId: r.data.artifactId })]);
  expect(dl.suggestedFilename()).toMatch(/Midnight-Invention\.wav$/);
  await expect(page.getByTestId(`artifact-${r.data.artifactId}`).getByTestId("artifact-download-wav")).toHaveAttribute("href", /^blob:/);

  // Reload: artifact persists, composition restored from IndexedDB.
  await page.waitForTimeout(1500); // autosave debounce (800 ms)
  await page.reload();
  await expect(page.getByTestId("workstation")).toBeVisible();
  await expect.poll(async () => page.evaluate(async () => ((await (document as any).modelContext?.getTools()) ?? []).length), { timeout: 20_000 }).toBeGreaterThan(40);
  const after = await tool(page, "gbk_list_render_artifacts", {});
  expect(after.data.artifacts.some((a: any) => a.artifactId === r.data.artifactId)).toBe(true);
  await expect.poll(async () => (await tool(page, "gbk_get_project_summary")).data.noteCount, { timeout: 20_000 }).toBe(summary.noteCount);
  await page.screenshot({ path: `${SHOTS}/gbk-midnight-03-reloaded.png` });
});

test("render immediately after creating and populating a project in a fresh page (live player never initialized)", async ({ page }) => {
  test.setTimeout(300_000);
  await freshPage(page);
  expect((await tool(page, "gbk_create_project", { name: "Instant", tempo: 132, key: "E minor", replaceCurrent: true })).ok).toBe(true);
  const t = await tool(page, "gbk_create_track", { tracks: [{ name: "Flute", program: 73 }, { name: "Drums", role: "percussion" }] });
  await tool(page, "gbk_generate_part", { trackId: t.data.trackIds[0], range: { unit: "bars", start: 1, end: 4 }, kind: "melody", seed: 4 });
  await tool(page, "gbk_generate_part", { trackId: t.data.trackIds[1], range: { unit: "bars", start: 1, end: 4 }, kind: "drums", seed: 4 });
  const r = await tool(page, "gbk_render_wav", { output: "bytes", channels: 1, sampleRate: 48000, tailSeconds: 1 });
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  expect(r.data.validated).toBe(true);
  expect(r.data.instruments[1].bank).toBe(128);
  expect(await page.evaluate(() => (window as any).__audio.resumed)).toBe(0);
  const empty = await tool(page, "gbk_create_project", { name: "Empty", replaceCurrent: true });
  expect(empty.ok).toBe(true);
  const fail = await tool(page, "gbk_render_wav", {});
  expect(fail.ok).toBe(false); expect(fail.error!.code).toBe("EMPTY_PROJECT");
});
