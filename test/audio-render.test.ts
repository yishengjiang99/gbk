import "./support/offline-audio-context.ts"; // OfflineAudioContext stand-in (renders never run without one)
// Headless renderer: real GeneralUser GS SoundFont, real Sf2SynthEngine, no AudioContext / player / WebMCP.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseSoundFont, resolveInstrument, loadSoundFont, clearSoundFontCache, defaultSoundFontUrl } from "../src/audio/soundfont-loader.ts";
import { renderProjectOffline, buildRenderPlan, type OfflineRenderOptions } from "../src/audio/offline-renderer.ts";
import { validateWav, parseWavHeader } from "../src/audio/audio-validation.ts";
import { wavHeader, encodeWav } from "../src/audio/wav-encoder.ts";
import { RenderError } from "../src/audio/render-error.ts";
import { ArtifactStore, MemoryArtifactBackend, base64 } from "../src/audio/artifact-store.ts";
import { RenderJobManager } from "../src/audio/render-job.ts";
import { emptyProject, type Project } from "../src/workstation/model.ts";
import { applyOps, type Op } from "../src/workstation/ops.ts";

const SF = parseSoundFont(new Uint8Array(readFileSync("public/static/GeneralUser-GS.sf2")), "GeneralUser-GS.sf2");
const deps = { soundFont: SF };
const OPT: OfflineRenderOptions = { sampleRate: 44100, channels: 2, format: "pcm16", tailSeconds: 2 };
const render = (p: Project, o: Partial<OfflineRenderOptions> = {}, signal?: AbortSignal) => renderProjectOffline(p, { ...OPT, ...o }, signal, undefined, deps);

/** 120 BPM 4/4, one track, sustained notes, CC11 curve: loud bar 1, quiet bar 2, loud bar 3. */
function fixture(extra: Op[] = [], program = 48, ch = 0): Project {
  const p = emptyProject("fixture");
  return applyOps(p, [
    { op: "addTrack", id: "t1", name: "Strings", channel: ch },
    { op: "setProgram", trackId: "t1", program, bankMsb: 0, bankLsb: 0 },
    { op: "addNotes", notes: [0, 1, 2].map((b) => ({ trackId: "t1", channel: ch, tick: b * 1920, duration: 1900, pitch: 60, velocity: 100 })) },
    { op: "setCC", trackId: "t1", channel: ch, controller: 11, startTick: 0, endTick: 5760, mode: "replace", points: [{ tick: 0, value: 127 }, { tick: 1920, value: 20 }, { tick: 3840, value: 127 }] },
    ...extra,
  ]);
}
const winDb = (r: { stats: { windowRmsDbFS: number[]; windowSeconds: number } }, from: number, to: number) => {
  const w = r.stats.windowRmsDbFS.slice(Math.round(from / r.stats.windowSeconds), Math.round(to / r.stats.windowSeconds));
  return Math.max(...w);
};

test("renders non-silent, correctly timed, unclipped PCM16 stereo with no audio context", async () => {
  assert.equal(typeof (globalThis as { AudioContext?: unknown }).AudioContext, "undefined");
  const r = await render(fixture());
  assert.equal(r.validated, true);
  assert.equal(r.sampleRate, 44100); assert.equal(r.channels, 2);
  assert.ok(Math.abs(r.durationSeconds - (5740 / 960 + 2)) < 0.01, `duration ${r.durationSeconds}`); // last note-off (tick 5740 @120) + 2 s tail
  assert.ok(r.peakDbFS > -45, `peak ${r.peakDbFS}`);
  assert.equal(r.clippedSamples, 0);
  assert.equal(r.instruments[0].presetName.length > 0, true);
  assert.equal(r.instruments[0].substituted, false);
  const h = parseWavHeader(r.bytes);
  assert.equal(h.container, "RIFF"); assert.equal(h.bitsPerSample, 16); assert.equal(h.frames, r.framesRendered);
  assert.equal(createHash("sha256").update(r.bytes).digest("hex"), r.sha256);
});

test("CC11 expression curve changes PCM amplitude (bar 2 at CC11=20 is much quieter)", async () => {
  const r = await render(fixture());
  const loud = winDb(r, 0.5, 1.8), quiet = winDb(r, 2.5, 3.8), loud2 = winDb(r, 4.5, 5.8);
  assert.ok(loud - quiet > 12, `loud ${loud} quiet ${quiet}`);
  assert.ok(loud2 - quiet > 12);
});

test("re-rendering the same project is byte-identical (deterministic)", async () => {
  const p = fixture();
  const a = await render(p), b = await render(p);
  assert.equal(a.sha256, b.sha256);
});

test("tempo change affects duration (tempo map honoured)", async () => {
  const p = fixture(); p.tempos = [{ tick: 0, microPerQuarter: 500000 }, { tick: 1920, microPerQuarter: 1000000 }]; // bar 2+ at 60 BPM
  const r = await render(p, { tailSeconds: 0 });
  assert.ok(Math.abs(r.musicSeconds - (2 + 3820 / 480)) < 0.001, `music ${r.musicSeconds}`); // bar 1 @120, rest @60
});

test("44.1 vs 48 kHz, mono vs stereo, float32", async () => {
  const p = fixture();
  const a = await render(p, { sampleRate: 48000, channels: 1 });
  assert.equal(a.wav.sampleRate, 48000); assert.equal(a.wav.channels, 1); assert.equal(a.framesRendered, Math.round(5740 / 960 * 48000) + 2 * 48000);
  const f = await render(p, { format: "float32" });
  assert.equal(f.wav.format, "float32"); assert.equal(f.wav.audioFormat, 3); assert.equal(f.byteLength, 58 + f.framesRendered * 8);
  await validateWav(f.blob, { format: "float32", sampleRate: 44100, channels: 2 });
});

test("normalize peak is whole-file (dynamics preserved vs the default loudness render)", async () => {
  const p = fixture();
  const n = await render(p, { normalize: true });
  assert.ok(Math.abs(n.peakDbFS - -1) < 0.3, `peak ${n.peakDbFS}`);
  const plain = await render(p);
  const dNorm = winDb(n, 0.5, 1.8) - winDb(n, 2.5, 3.8), dPlain = winDb(plain, 0.5, 1.8) - winDb(plain, 2.5, 3.8);
  assert.ok(Math.abs(dNorm - dPlain) < 1, "relative CC11 dynamics kept");
});

test("effects tails and note releases are included in the tail", async () => {
  const p = fixture([{ op: "setEffects", params: { enabled: true } }, { op: "setCC", trackId: "t1", channel: 0, controller: 91, startTick: 0, endTick: 0, mode: "replace", points: [{ tick: 0, value: 127 }] }]);
  const r = await render(p, { tailSeconds: 3 });
  assert.ok(winDb(r, 6.1, 6.6) > -80, `tail ${winDb(r, 6.1, 6.6)}`);
  assert.ok(r.stats.lastAudibleSec! > 6.1);
});

test("CC64 sustain keeps notes sounding after note-off until pedal release", async () => {
  const p = applyOps(emptyProject("ped"), [
    { op: "addTrack", id: "t", name: "Piano", channel: 0 }, { op: "setProgram", trackId: "t", program: 0, bankMsb: 0, bankLsb: 0 },
    { op: "addNotes", notes: [{ trackId: "t", channel: 0, tick: 0, duration: 240, pitch: 60, velocity: 110 }] },
    { op: "setCC", trackId: "t", channel: 0, controller: 64, startTick: 0, endTick: 3840, mode: "replace", points: [{ tick: 0, value: 127 }, { tick: 3840, value: 0 }] },
  ]);
  const ped = await render(p, { tailSeconds: 1 });
  const dry = await render(applyOps(p, [{ op: "removeCC", ids: p.ccs.map((c) => c.id) }]), { tailSeconds: 1 });
  assert.ok(winDb(ped, 1.5, 2) - winDb(dry, 1.5, 2) > 10, `pedal ${winDb(ped, 1.5, 2)} dry ${winDb(dry, 1.5, 2)}`);
});

test("percussion on channel 10 resolves the drum bank; multiple simultaneous channels", async () => {
  const p = applyOps(fixture(), [
    { op: "addTrack", id: "d", name: "Drums", channel: 9 }, { op: "setProgram", trackId: "d", program: 0, bankMsb: 0, bankLsb: 0 },
    { op: "addNotes", notes: [0, 480, 960, 1440].map((tick) => ({ trackId: "d", channel: 9, tick, duration: 120, pitch: 36, velocity: 110 })) },
  ]);
  const r = await render(p);
  const d = r.instruments.find((x) => x.trackId === "d")!;
  assert.equal(d.bank, 128);
  assert.equal(r.instruments.length, 2);
});

test("missing instrument -> explicit substitution warning", () => {
  const r = resolveInstrument(SF.sf, 48, 77, 0);
  assert.equal(r.substituted, true); assert.match(r.warning!, /not in SoundFont/);
});

test("very quiet composition passes with a lower threshold; all-muted fails as silence", async () => {
  const quiet = applyOps(fixture(), [{ op: "updateTrack", trackId: "t1", mix: { volume: 8 } }]);
  const q = await render(quiet, { silenceThresholdDbFS: -90 });
  assert.ok(q.peakDbFS < -20);
  const muted = applyOps(fixture(), [{ op: "updateTrack", trackId: "t1", mix: { mute: true } }]);
  await assert.rejects(render(muted), (e: RenderError) => e.code === "UNEXPECTED_SILENCE");
});

test("empty project rejects with EMPTY_PROJECT; allowSilence renders an intentional silent file", async () => {
  await assert.rejects(render(emptyProject()), (e: RenderError) => e.code === "EMPTY_PROJECT");
  const p = applyOps(emptyProject(), [{ op: "addTrack", id: "x", name: "x", channel: 0 }, { op: "addNotes", notes: [{ trackId: "x", channel: 0, tick: 0, duration: 480, pitch: 60, velocity: 90 }] }, { op: "updateTrack", trackId: "x", mix: { mute: true } }]);
  const s = await render(p, { allowSilence: true });
  assert.equal(s.peakDbFS, -999);
});

test("declared song structure sets the musical length (bar-aligned) even when the last note ends earlier", async () => {
  const p = fixture([{ op: "setSections", sections: [{ name: "A", startBar: 1, bars: 4 }] } as Op]);
  const r = await render(p, { tailSeconds: 0 });
  assert.ok(Math.abs(r.musicSeconds - 8) < 0.001, `music ${r.musicSeconds}`);
});

test("notes extending beyond the last bar are rendered to their end", async () => {
  const p = fixture([{ op: "addNotes", notes: [{ trackId: "t1", channel: 0, tick: 5000, duration: 3000, pitch: 64, velocity: 90 }] }]);
  const r = await render(p, { tailSeconds: 0 });
  assert.ok(Math.abs(r.musicSeconds - 8000 / 960) < 0.001); // rendered to the note end, past the last bar line
});

test("cancellation rejects with OPERATION_CANCELLED", async () => {
  const ac = new AbortController(); ac.abort();
  await assert.rejects(render(fixture(), {}, ac.signal), (e: RenderError) => e.code === "OPERATION_CANCELLED");
});

test("invalid / missing SoundFont -> structured errors", async () => {
  assert.throws(() => parseSoundFont(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), (e: RenderError) => e.code === "SOUNDFONT_INVALID");
  clearSoundFontCache();
  const fetchImpl = (async () => new Response("nope", { status: 404 })) as typeof fetch;
  await assert.rejects(loadSoundFont({ url: "/gbk/static/missing.sf2", fetchImpl }), (e: RenderError) => e.code === "SOUNDFONT_FETCH_FAILED");
  assert.equal(defaultSoundFontUrl(), "/static/GeneralUser-GS.sf2"); // Vite injects /gbk/ in the app build
});

test("render plan honours mute/solo and program changes", () => {
  const p = applyOps(fixture(), [{ op: "addTrack", id: "t2", name: "B", channel: 1 }, { op: "addNotes", notes: [{ trackId: "t2", channel: 1, tick: 0, duration: 480, pitch: 48, velocity: 80 }] }, { op: "updateTrack", trackId: "t2", mix: { solo: true } }]);
  const plan = buildRenderPlan(p, SF.sf, 44100);
  assert.equal(plan.tracks[0].gain, 0); assert.equal(plan.tracks[1].gain, 1);
  assert.equal(plan.audibleNotes, 1);
});

test("WAV encoder/validator: header fields, RF64 header, corrupt file rejected", async () => {
  const w = encodeWav({ sampleRate: 48000, channels: 1, format: "pcm16" }, new Float32Array([0, 0.5, -0.5, 1]));
  const h = parseWavHeader(w);
  assert.deepEqual([h.sampleRate, h.channels, h.blockAlign, h.byteRate, h.frames, h.dataBytes], [48000, 1, 2, 96000, 4, 8]);
  const dv = new DataView(w.buffer); assert.equal(dv.getInt16(44 + 2, true), 16384); // little endian 0.5
  const big = wavHeader({ sampleRate: 48000, channels: 2, format: "float32", frames: 2 ** 29 + 1 });
  assert.equal(String.fromCharCode(...big.subarray(0, 4)), "RF64");
  const bad = w.slice(); bad[8] = 0x58;
  await assert.rejects(validateWav(bad, { expectAudible: false }), (e: RenderError) => e.code === "WAV_INVALID");
  const trunc = w.slice(0, 48);
  await assert.rejects(validateWav(trunc, { expectAudible: false }), (e: RenderError) => e.code === "WAV_INVALID");
  const nan = encodeWav({ sampleRate: 44100, channels: 1, format: "float32" }, new Float32Array([0.1, 0.2]));
  new DataView(nan.buffer).setFloat32(nan.length - 4, NaN, true);
  await assert.rejects(validateWav(nan), (e: RenderError) => e.code === "NON_FINITE_SAMPLES" || e.code === "WAV_INVALID");
});

test("artifact store: persist, bounded chunk reads rebuild identical bytes (SHA-256), quota error, delete", async () => {
  const backend = new MemoryArtifactBackend(); const store = new ArtifactStore(backend);
  const r = await render(fixture());
  const a = await store.save({ kind: "wav", filename: "f.wav", mimeType: "audio/wav", sha256: r.sha256, projectId: "p", projectName: "f", revision: 1 }, r.blob);
  const parts: Uint8Array[] = []; let off = 0;
  for (;;) { const c = await store.readRange(a.id, off, 256 * 1024); parts.push(new Uint8Array(Buffer.from(base64(c.bytes), "base64"))); off += c.bytes.length; if (c.eof) break; }
  const rebuilt = Buffer.concat(parts);
  assert.equal(createHash("sha256").update(rebuilt).digest("hex"), r.sha256);
  const v = await validateWav(new Uint8Array(rebuilt), { sampleRate: 44100, channels: 2 });
  assert.ok(v.stats.peakDbFS > -45, `peak ${v.stats.peakDbFS}`);
  await assert.rejects(store.readRange(a.id, 0, 256 * 1024 + 1), (e: RenderError) => e.code === "INVALID_ARGUMENT");
  backend.failNextPut = Object.assign(new Error("quota"), { name: "QuotaExceededError" });
  await assert.rejects(store.save({ kind: "wav", filename: "g.wav", mimeType: "audio/wav", sha256: "", projectId: "p", projectName: "g", revision: 1 }, r.blob), (e: RenderError) => e.code === "QUOTA_EXCEEDED");
  await store.delete(a.id);
  await assert.rejects(store.meta(a.id), (e: RenderError) => e.code === "ARTIFACT_NOT_FOUND");
});

test("render jobs: snapshot isolation, concurrent requests serialized, cancellation", async () => {
  const store = new ArtifactStore(new MemoryArtifactBackend());
  const jobs = new RenderJobManager(() => store, deps);
  let p = fixture();
  const j1 = jobs.submit(p, OPT);
  p = applyOps(p, [{ op: "removeNotes", ids: p.notes.map((n) => n.id) }]); // edit after submit must not affect j1
  const j2 = jobs.submit(fixture(), { ...OPT, sampleRate: 48000 });
  const j3 = jobs.submit(fixture(), OPT); jobs.cancel(j3.id);
  const [r1, r2, r3] = await Promise.all([jobs.wait(j1.id), jobs.wait(j2.id), jobs.wait(j3.id)]);
  assert.equal(r1.status, "completed"); assert.equal(r1.result!.noteCount, 3);
  assert.equal(r2.status, "completed"); assert.equal(r2.result!.sampleRate, 48000);
  assert.equal(r3.status, "cancelled"); assert.equal(r3.artifactId, undefined);
  assert.equal((await store.list()).length, 2);
  assert.ok(r1.finishedAt! <= r2.finishedAt!);
});
