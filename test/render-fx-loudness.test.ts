import "./support/offline-audio-context.ts"; // OfflineAudioContext stand-in (renders never run without one)
// Offline reverb/chorus audibility + tail, whole-file loudness normalization, determinism, live-parity auto-pan
// and pinned player preset overrides.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSoundFont } from "../src/audio/soundfont-loader.ts";
import { renderProjectOffline, type OfflineRenderOptions } from "../src/audio/offline-renderer.ts";
import { parseWavHeader } from "../src/audio/audio-validation.ts";
import { LoudnessMeter, chooseGain } from "../src/audio/loudness.ts";
import { stereoPanGains, resolveOrchestraPan } from "../src/audio/orchestra-pan.ts";
import { SF2Effects } from "../src/sf2/effects.ts";
import { emptyProject, type Project } from "../src/workstation/model.ts";
import { applyOps, type Op } from "../src/workstation/ops.ts";

const SF = parseSoundFont(new Uint8Array(readFileSync("public/static/GeneralUser-GS.sf2")), "GeneralUser-GS.sf2");
const render = (p: Project, o: Partial<OfflineRenderOptions> = {}) =>
  renderProjectOffline(p, { sampleRate: 44100, channels: 2, format: "float32", tailSeconds: 3, ...o }, undefined, undefined, { soundFont: SF });

function song(opts: { name?: string; program?: number; cc91?: number; dyn?: boolean } = {}): Project {
  const ops: Op[] = [
    { op: "addTrack", id: "t1", name: opts.name ?? "Piano", channel: 0 },
    { op: "setProgram", trackId: "t1", program: opts.program ?? 0, bankMsb: 0, bankLsb: 0 },
    { op: "addNotes", notes: [0, 1, 2, 3].map((b) => ({ trackId: "t1", channel: 0, tick: b * 1920, duration: 960, pitch: 60 + b * 4, velocity: 100 })) },
  ];
  if (opts.cc91 !== undefined) ops.push({ op: "setCC", trackId: "t1", channel: 0, controller: 91, startTick: 0, endTick: 0, mode: "replace", points: [{ tick: 0, value: opts.cc91 }] });
  if (opts.dyn) ops.push({ op: "setCC", trackId: "t1", channel: 0, controller: 11, startTick: 0, endTick: 7680, mode: "replace", points: [{ tick: 0, value: 127 }, { tick: 3840, value: 40 }] });
  return applyOps(emptyProject("fx"), ops);
}
/** Float32 interleaved stereo samples of a rendered WAV. */
function pcm(bytes: Uint8Array) {
  const h = parseWavHeader(bytes);
  return { h, s: new Float32Array(bytes.buffer.slice(bytes.byteOffset + h.dataOffset, bytes.byteOffset + h.dataOffset + h.dataBytes)) };
}
const rmsDb = (s: Float32Array, sr: number, a: number, b: number, ch = -1) => {
  let e = 0, n = 0;
  for (let i = Math.floor(a * sr); i < Math.floor(b * sr); i++) for (let c = 0; c < 2; c++) if (ch < 0 || ch === c) { e += s[i * 2 + c] ** 2; n++; }
  return 10 * Math.log10(e / n + 1e-30);
};

test("reverb return is restored to FluidSynth's default level (Freeverb scalewet)", () => {
  assert.ok(Math.abs(new SF2Effects(44100).reverbWet - 2.7) < 1e-6);
  const e = new SF2Effects(44100); e.setParams({ reverbLevel: 1 }); assert.ok(Math.abs(e.reverbWet - 5.4) < 1e-6);
});

test("reverb: CC91 tail is clearly audible after the last note-off and lies inside tailSeconds", async () => {
  const dry = await render(song({ cc91: 0 }), { normalize: "off" }), wet = await render(song({ cc91: 127 }), { normalize: "off" });
  const sr = 44100, end = 3 * 2 + 1; // last note-off at bar 4 beat 2 = 7 s
  const d = pcm(dry.bytes).s, w = pcm(wet.bytes).s;
  const tailDry = rmsDb(d, sr, end + 0.25, end + 1), tailWet = rmsDb(w, sr, end + 0.25, end + 1);
  const body = rmsDb(w, sr, 6, 7);
  console.log(`# tail dry ${tailDry.toFixed(1)} dB, wet ${tailWet.toFixed(1)} dB, body ${body.toFixed(1)} dB`);
  assert.ok(tailWet - tailDry > 10, `wet tail ${tailWet.toFixed(1)} vs dry ${tailDry.toFixed(1)}`);
  assert.ok(body - tailWet < 35, "tail within 35 dB of the music body (audible)");
  assert.ok(rmsDb(w, sr, end + 1, end + 1.5) - rmsDb(d, sr, end + 1, end + 1.5) > 10, "reverb still ringing 1-1.5 s after the last note-off");
  assert.ok(rmsDb(w, sr, wet.durationSeconds - 0.3, wet.durationSeconds) < tailWet - 30, "tail decays inside tailSeconds (not cut)");
});

test("determinism: identical input renders to an identical hash (reverb, chorus, loudness, multi-track)", async () => {
  const p = applyOps(song({ cc91: 100, dyn: true, name: "Violin", program: 40 }), [
    { op: "addTrack", id: "t2", name: "Cello", channel: 1 }, { op: "setProgram", trackId: "t2", program: 42, bankMsb: 0, bankLsb: 0 },
    { op: "addNotes", notes: [{ trackId: "t2", channel: 1, tick: 0, duration: 3840, pitch: 48, velocity: 90 }] },
    { op: "setCC", trackId: "t2", channel: 1, controller: 93, startTick: 0, endTick: 0, mode: "replace", points: [{ tick: 0, value: 127 }] },
  ]);
  const a = await render(p, { format: "pcm16" }), b = await render(p, { format: "pcm16" });
  assert.equal(a.sha256, b.sha256);
  assert.deepEqual(a.loudness, b.loudness);
});

test("loudness default: whole file at -16 LUFS integrated, true peak <= -1 dBTP, relative dynamics untouched", async () => {
  const p = song({ cc91: 60, dyn: true });
  const raw = await render(p, { normalize: "off" }), n = await render(p);
  assert.equal(n.loudness.mode, "loudness");
  // Independent re-measurement of the encoded file.
  const { s } = pcm(n.bytes); const L = new Float32Array(s.length / 2), R = new Float32Array(s.length / 2);
  for (let i = 0; i < L.length; i++) { L[i] = s[2 * i]; R[i] = s[2 * i + 1]; }
  const m = new LoudnessMeter(44100, 2); m.push(L, R, L.length); const st = m.result();
  console.log(`# loudness ${JSON.stringify(n.loudness)} remeasured ${st.integratedLufs.toFixed(2)} LUFS ${st.truePeakDbTP.toFixed(2)} dBTP`);
  if (n.loudness.limitedBy === "loudness") assert.ok(Math.abs(st.integratedLufs - -16) < 0.2, `${st.integratedLufs}`);
  assert.ok(st.truePeakDbTP <= -0.95, `true peak ${st.truePeakDbTP}`);
  assert.ok(Math.abs(n.loudness.outputLufs - st.integratedLufs) < 0.05, "reported output loudness = measured");
  // One gain for the file: loud vs quiet section contrast is identical to the raw render.
  const r = pcm(raw.bytes).s;
  const dRaw = rmsDb(r, 44100, 0.1, 0.9) - rmsDb(r, 44100, 6.1, 6.9), dN = rmsDb(s, 44100, 0.1, 0.9) - rmsDb(s, 44100, 6.1, 6.9);
  assert.ok(Math.abs(dRaw - dN) < 0.05, `contrast raw ${dRaw.toFixed(2)} vs normalized ${dN.toFixed(2)}`);
  assert.ok(dRaw > 3, "fixture really has dynamics");
});

test("loudness: true-peak ceiling wins over the LUFS target for peaky material; peak mode hits -1 dBTP", () => {
  const g = chooseGain("loudness", { integratedLufs: -30, truePeakDbTP: -6, samplePeakDbFS: -6.2 });
  assert.equal(g.limitedBy, "truePeak"); assert.equal(g.gainDb, 5); assert.equal(g.outputTruePeakDbTP, -1);
  const q = chooseGain("loudness", { integratedLufs: -30, truePeakDbTP: -20, samplePeakDbFS: -20 });
  assert.equal(q.limitedBy, "loudness"); assert.equal(q.outputLufs, -16);
  assert.equal(chooseGain("peak", { integratedLufs: -30, truePeakDbTP: -20, samplePeakDbFS: -20 }).outputTruePeakDbTP, -1);
  assert.equal(chooseGain("off", { integratedLufs: -30, truePeakDbTP: -20, samplePeakDbFS: -20 }).gainDb, 0);
});

test("loudness meter matches BS.1770 reference: 997 Hz full-scale sine on both channels = 0 LUFS (+-0.1)", () => {
  const sr = 48000, n = sr * 3; const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = Math.sin(2 * Math.PI * 997 * i / sr);
  const m = new LoudnessMeter(sr, 2); m.push(L, L, n);
  assert.ok(Math.abs(m.result().integratedLufs) < 0.1);
});

test("auto-pan: orchestra seating matches the live StereoPannerNode law; autoPan:false keeps the centre", async () => {
  assert.equal(resolveOrchestraPan("Violin", "Violin"), -0.75);
  assert.deepEqual(stereoPanGains(0), { ll: 1, rl: Math.cos(Math.PI / 2), lr: 0, rr: 1 });
  const p = song({ name: "Violin", program: 40 });
  const panned = await render(p, { normalize: "off", autoPan: true }), centre = await render(p, { normalize: "off" }); // autoPan is opt-in
  assert.equal(panned.instruments[0].pan, -0.75); assert.equal(centre.instruments[0].pan, 0);
  const a = pcm(panned.bytes).s, c = pcm(centre.bytes).s;
  const lrP = rmsDb(a, 44100, 0, 7, 0) - rmsDb(a, 44100, 0, 7, 1), lrC = rmsDb(c, 44100, 0, 7, 0) - rmsDb(c, 44100, 0, 7, 1);
  assert.ok(lrP - lrC > 6, `violin left-weighted: ${lrP.toFixed(1)} vs ${lrC.toFixed(1)} dB`);
});

test("player preset override is pinned (program changes ignored) and reported", async () => {
  const p = applyOps(song({ program: 0 }), [{ op: "setProgram", trackId: "t1", program: 24, bankMsb: 0, bankLsb: 0, tick: 3840 } as Op]);
  const harp = SF.sf.presets.findIndex((h) => h.bank === 0 && h.preset === 46);
  const r = await render(p, { normalize: "off", presetOverrides: { t1: harp } });
  assert.equal(r.instruments[0].presetOverride, true); assert.equal(r.instruments[0].program, 46);
  const plain = await render(p, { normalize: "off" });
  assert.notEqual(r.sha256, plain.sha256);
  const bad = await render(p, { normalize: "off", presetOverrides: { t1: 99999 } });
  assert.ok(bad.warnings.some((w) => /not in this SoundFont/.test(w)));
});
