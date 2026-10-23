// Matrix rows G-xx and render-measured S-xx / MIDI-01. Ported from sf2player-swift ComplianceG/G2/G11Tests.
import test from "node:test";
import assert from "node:assert/strict";
import { SF2SoundFont, STRICT } from "../src/sf2/soundfont.ts";
import { genInfo } from "../src/sf2/geninfo.ts";
import { modCurve } from "../src/sf2/modulator.ts";
import { ModEnv } from "../src/sf2-renderer.ts";
import { SF2Builder as B, Gen } from "./support/sf2-builder.ts";
import { Analysis as A, SpecRender } from "./support/analysis.ts";

type G = [number, number][];
const sr = 44100;
const near = (a: number, b: number, tol: number, msg = "") => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
const sineBank = (g: G = [], pitch = 60) => B.single(B.sine(100, 4410), { loop: [0, 4410], pitch, instGens: [[Gen.sampleModes, 1], ...g] });
function f0(b: B, key: number): number {
  const r = new SpecRender(b); r.noteOn(key);
  return A.f0ZeroCrossing(r.render(r.seconds(0.6)).l, sr, 2205);
}
const first = (r: SpecRender) => r.engine.debugVoice(0)!;

test("test_G01_measuredPitch", () => {
  const cases: [G, number, number, string][] = [
    [[], 60, 1000, "root"], [[], 72, 2000, "octave up"],
    [[[Gen.scaleTuning, 50]], 72, 1000 * Math.pow(2, 0.5), "scaleTuning 50"],
    [[[Gen.scaleTuning, 0]], 84, 1000, "scaleTuning 0"],
    [[[Gen.coarseTune, -4]], 60, 1000 * Math.pow(2, -4 / 12), "coarse -4"],
    [[[Gen.fineTune, -5]], 60, 1000 * Math.pow(2, -5 / 1200), "fine -5"],
    [[[Gen.overridingRootKey, 69]], 69, 1000, "overridingRootKey 69"],
  ];
  for (const [g, key, hz, label] of cases) near(A.cents(f0(sineBank(g), key), hz), 0, 1, label);
  const r = new SpecRender(sineBank()); r.noteOn(60);
  near(A.cents(A.f0Autocorrelation(r.render(20000).l, sr, 4000), 1000), 0, 1, "autocorrelation");
  const half = sineBank(); half.sampleHeaders[0].rate = 22050;
  near(A.cents(f0(half, 60), 500), 0, 1, "22050 Hz sample");
});

test("test_S07_pitchCorrectionMeasured", () => {
  const b = sineBank(); b.sampleHeaders[0].corr = -4;
  near(A.cents(f0(b, 60), 1000), -4, 1);
});

test("test_G09_initialAttenuation", () => {
  const level = (cb: number) => {
    const r = new SpecRender(B.single(B.dc(4000), { loop: [100, 3900], instGens: [[Gen.sampleModes, 1], [Gen.initialAttenuation, cb]] }));
    r.noteOn(60); return A.rmsDB(r.render(4000).l, 2000);
  };
  const ref = level(0);
  for (const cb of [60, 200, 480, 960]) near(level(cb) - ref, -cb / 10, 0.1, `${cb} cB`);
});

test("test_G10_linearPanLaw", () => {
  const sums: number[] = [];
  for (const [pan, share] of [[-500, 1], [-250, 0.75], [0, 0.5], [250, 0.25], [500, 0]]) {
    const r = new SpecRender(B.single(B.dc(4000, 16384), { loop: [100, 3900], instGens: [[Gen.sampleModes, 1], [Gen.pan, pan]] }));
    r.noteOn(60);
    const o = r.render(3000), l = o.l[2000], rr = o.r[2000];
    near(l / (l + rr), share, 0.0058, `pan ${pan}`);
    sums.push(l + rr);
  }
  for (const s of sums) near(A.db(s / sums[2]), 0, 0.1, "L+R constant");
});

test("test_S03_signedAddressOffsets", () => {
  const ramp = Array.from({ length: 200 }, (_, i) => i * 100);
  const region = (g: G) => {
    const b = B.single(ramp, { loop: [50, 150], instGens: g });
    b.samples.push(...new Array(100).fill(-7));
    b.sampleHeaders.push({ name: "n", start: 246, end: 346, loopStart: 0, loopEnd: 0 });
    return new SF2SoundFont(b.build(), STRICT).buildRegionsForPreset(0)[0];
  };
  let r = region([[Gen.startAddrsOffset, 10]]);
  assert.equal(r.sample.dataL[0], Math.fround(1000 / 32768)); assert.equal(r.sample.end, 190);
  r = region([[Gen.startAddrsOffset, -20]]);
  assert.equal(r.sample.dataL.length, 200); assert.equal(r.sample.dataL[0], 0);
  r = region([[Gen.endAddrsOffset, 80]]);
  assert.equal(r.sample.dataL.length, 200);
  assert.ok(!r.sample.dataL.some((v) => v === Math.fround(-7 / 32768)));
  r = region([[Gen.endAddrsOffset, -50]]);
  assert.equal(r.sample.dataL.length, 150);
  r = region([[Gen.startloopAddrsOffset, -10], [Gen.endloopAddrsOffset, 5]]);
  assert.equal(r.sample.loopStart, 40); assert.equal(r.sample.loopEnd, 155);
  r = region([[Gen.endAddrsCoarseOffset, -1]]);
  assert.ok(r.sample.end > r.sample.start);
});

test("test_S04_zeroSampleRate", () => {
  const b = sineBank(); b.sampleHeaders[0].rate = 0;
  const r = new SpecRender(b); r.noteOn(60);
  assert.ok(r.render(4410).l.every(Number.isFinite));
  assert.equal(new SF2SoundFont(b.build(), STRICT).buildRegionsForPreset(0)[0].sample.sampleRate, 400);
});

test("test_S08_sampleModesLowBits", () => {
  const sounding = (mode: number, frames = 3000) => {
    const r = new SpecRender(B.single(B.dc(200), { loop: [20, 180], instGens: [[Gen.sampleModes, mode]] }));
    r.noteOn(60); return A.rmsDB(r.render(frames).l, frames - 200);
  };
  assert.ok(sounding(1) > -20); assert.ok(sounding(5) > -20, "5 -> 1");
  assert.ok(sounding(0) < -200); assert.ok(sounding(2) < -200); assert.ok(sounding(6) < -200);
  const r = new SpecRender(B.single(B.dc(200), { loop: [20, 180], instGens: [[Gen.sampleModes, 3], [Gen.releaseVolEnv, 1200]] }));
  r.noteOn(60);
  assert.ok(A.rmsDB(r.render(3000).l, 2800) > -20);
  r.noteOff(60);
  assert.ok(A.rmsDB(r.render(1000).l, 400) < -200, "mode 3 plays to the end after key-off");
});

test("test_S11_readPastEndIsSilent", () => {
  const b = B.single(B.dc(100), { instGens: [[Gen.releaseVolEnv, 1200]] });
  b.samples = [...B.dc(100), ...B.dc(46, 30000)];
  const r = new SpecRender(b); r.noteOn(60);
  const o = r.render(400);
  assert.equal(o.l[150], 0); assert.equal(o.l[399], 0);
});

test("test_MIDI01_velocityZeroIsNoteOff", () => {
  const r = new SpecRender(B.single(B.dc(4000), { loop: [100, 3900], instGens: [[Gen.sampleModes, 1]] }));
  r.noteOn(60); r.render(100); r.noteOn(60, 0);
  assert.ok(A.rmsDB(r.render(6000).l, 5800) < -90);
});

function envelope(g: G, noteOffAt: number | null, seconds: number) {
  const r = new SpecRender(B.single(B.dc(8000), { loop: [100, 7900], instGens: [[Gen.sampleModes, 1], ...g] }));
  r.noteOn(60);
  let out: number[];
  if (noteOffAt !== null) { out = [...r.render(r.seconds(noteOffAt)).l]; r.noteOff(60); out.push(...r.render(r.seconds(seconds - noteOffAt)).l); }
  else out = [...r.render(r.seconds(seconds)).l];
  const ref = new SpecRender(B.single(B.dc(8000), { loop: [100, 7900], instGens: [[Gen.sampleModes, 1]] }));
  ref.noteOn(60);
  const peak = Math.abs(ref.render(2000).l[1500]);
  return { e: out.map((v) => A.db(Math.abs(v) / peak)), r };
}

test("test_G03_volumeEnvelopeShape", () => {
  const { e, r } = envelope([[Gen.attackVolEnv, -1200], [Gen.holdVolEnv, -2400], [Gen.decayVolEnv, 0], [Gen.sustainVolEnv, 600], [Gen.releaseVolEnv, 0]], 2.0, 2.5);
  const at = (s: number) => e[Math.trunc(s * sr)];
  near(at(0.25), A.db(0.5), 0.1, "linear attack"); near(at(0.125), A.db(0.25), 0.1);
  near(at(0.6), 0, 0.1, "hold"); near(at(1.05), -30, 0.1, "decay dB rate"); near(at(1.25), -50, 0.1);
  let reach = Math.trunc(0.75 * sr); while (!(e[reach] <= -60 + 0.05)) reach++;
  near(reach / sr, 1.35, Math.max(0.001, 0.02 * 0.6), "sustain after decay * 600/1000");
  near(at(1.8), -60, 0.1); near(at(2.2), -80, 0.1, "release 100 dB/s");
  let end = Math.trunc(2 * sr); while (!(e[end] < -200)) end++;
  near(end / sr, 2.36, 0.002, "ends at 96 dB");
  assert.equal(r.engine.voiceCount, 0);
});

test("test_G03_releaseFromAttackUsesCurrentLevel", () => {
  const { e } = envelope([[Gen.attackVolEnv, 0], [Gen.releaseVolEnv, 0]], 0.1, 0.4);
  near(e[Math.trunc(0.1 * sr) - 1], A.db(0.1), 0.1);
  near(e[Math.trunc(0.2 * sr)], A.db(0.1) - 10, 0.1);
});

test("test_G04_modulationEnvelopeShape", () => {
  const m = new ModEnv(1000);
  m.setFromSf2({ delayTc: -12000, attackTc: 0, holdTc: -12000, decayTc: 0, sustain: 0.4, releaseTc: 0 });
  m.noteOn();
  const y: number[] = []; for (let i = 0; i < 3000; i++) y.push(m.next());
  near(y[499], modCurve(2, 0.5), 1e-3, "convex attack"); assert.ok(y[499] > 0.5);
  near(y[1300], 0.7, 2e-3, "linear decay"); near(y[1650], 0.4, 1e-9, "sustain after 0.6 s");
  m.noteOff();
  const rel: number[] = []; for (let i = 0; i < 500; i++) rel.push(m.next());
  near(rel[199], 0.2, 2e-3); assert.equal(rel[450], 0);
  const r = new SpecRender(sineBank([[Gen.modEnvToPitch, 1200], [Gen.sustainModEnv, 500], [Gen.decayModEnv, -12000]]));
  r.noteOn(60);
  near(A.cents(A.f0ZeroCrossing(r.render(22050).l, sr, 4410), 1000), 600, 1);
});

function dcLevels(g: G, key = 60, frames: number): number[] {
  const r = new SpecRender(B.single(B.dc(8000), { loop: [100, 7900], instGens: [[Gen.sampleModes, 1], ...g] }));
  r.noteOn(key);
  const out = r.render(frames).l;
  let peak = 0; for (const v of out) peak = Math.max(peak, Math.abs(v));
  return [...out].map((v) => A.db(Math.abs(v) / peak));
}
const firstIdx = (e: number[], f: (v: number, i: number) => boolean) => e.findIndex((v, i) => f(v, i));

test("test_G05_keynumEnvelopeScaling", () => {
  const e = dcLevels([[Gen.holdVolEnv, -7973], [Gen.keynumToVolEnvHold, 50], [Gen.decayVolEnv, -1200], [Gen.sustainVolEnv, 1000], [Gen.attackVolEnv, -12000]], 36, 4410);
  near(firstIdx(e, (v, i) => i > 100 && v < -0.1) / sr, 0.0225, 0.001, "key 36 hold 20 ms");
  const e60 = dcLevels([[Gen.holdVolEnv, -7973], [Gen.keynumToVolEnvHold, 50], [Gen.decayVolEnv, -1200], [Gen.sustainVolEnv, 1000]], 60, 4410);
  near(firstIdx(e60, (v, i) => i > 100 && v < -0.1) / sr, 0.0125, 0.001, "key 60 hold 10 ms");
  const d = dcLevels([[Gen.decayVolEnv, -1200], [Gen.keynumToVolEnvDecay, 100], [Gen.sustainVolEnv, 1000]], 48, 44100);
  near(d[Math.trunc(0.502 * sr)], -50, 0.2, "decay doubled");
  const r = new SpecRender(B.single(B.dc(800), { loop: [10, 790], instGens: [[Gen.sampleModes, 1], [Gen.holdModEnv, -1200], [Gen.keynumToModEnvHold, 100], [Gen.decayModEnv, 0], [Gen.keynumToModEnvDecay, -100]] }));
  r.noteOn(48);
  near(first(r).modEnv.hold, 1, 1e-9); near(first(r).modEnv.decay, 0.5, 1e-9);
});

test("test_G06_lfoTriangleFrequencyAndPhase", () => {
  const f = 8.176 * 2;
  const e = dcLevels([[Gen.modLfoToVolume, 60], [Gen.freqModLFO, 1200], [Gen.delayModLFO, -2400]], 60, 44100);
  const base = e[Math.trunc(0.2 * sr)];
  const at = (t: number) => e[Math.trunc((0.25 + t) * sr)] - base;
  near(at(0.0005), 6 * 4 * f * 0.0005, 0.05, "starts at 0 rising");
  near(at(1 / (4 * f)), 6, 0.1); near(at(1 / (2 * f)), 0, 0.1); near(at(3 / (4 * f)), -6, 0.1);
  near(at(1 / f + 1 / (8 * f)), 3, 0.1, "triangle");
  const r = new SpecRender(B.single(B.sine(100, 4410), { loop: [0, 4410], instGens: [[Gen.sampleModes, 1], [Gen.vibLfoToPitch, 100], [Gen.freqVibLFO, -2400]] }));
  r.noteOn(60);
  const o = r.render(44100).l;
  const crest = Math.trunc((0.002 + 1 / (4 * 2.044)) * sr);
  near(A.cents(A.f0ZeroCrossing(o, sr, crest - 220, 441), 1000), 100 * (1 - 2 * 2.044 * 0.005), 1, "vibrato crest");
  near(A.rmsDB(o, 20000, 4410) - A.rmsDB(o, 4410, 4410), 0, 0.1, "no level change");
});

test("test_G07_modEnvToPitchAndFc", () => {
  const r = new SpecRender(B.single(B.dc(800), { loop: [10, 790], instGens: [[Gen.sampleModes, 1], [Gen.initialFilterFc, 6000], [Gen.modEnvToFilterFc, 1200], [Gen.sustainModEnv, 500]] }));
  r.noteOn(60); r.render(441);
  near(first(r).lastFc, 6600, 1e-9);
});

function response(hz: number | null, fcCents: number, qCb: number): number {
  const wave = hz !== null ? B.sine(Math.trunc(hz / 10), 4410) : B.dc(4410);
  const render = (g: G) => { const r = new SpecRender(B.single(wave, { loop: [0, 4410], instGens: [[Gen.sampleModes, 1], ...g] })); r.noteOn(60); return r.render(22050).l; };
  const f = render([[Gen.initialFilterFc, fcCents], [Gen.initialFilterQ, qCb]]), u = render([]);
  if (hz !== null) return A.db(A.goertzel(f, hz, sr, 4410, 17640) / A.goertzel(u, hz, sr, 4410, 17640));
  return A.rmsDB(f, 4410) - A.rmsDB(u, 4410);
}

test("test_G08_filterDcAndPeak", () => {
  const fc = 1000, cents = Math.round(1200 * Math.log2(fc / 8.176));
  near(response(null, cents, 100), -5, 1, "DC -5 dB"); near(response(fc, cents, 100), 5, 1, "peak +5 dB");
  const g = Math.pow(10, 0.5), q = Math.sqrt((g * g + g * Math.sqrt(g * g - 1)) / 2);
  near(response(2 * fc, cents, 100), A.db(1 / Math.sqrt(9 + 4 / (q * q))) - 5, 1, "2 fc");
  near(response(null, cents, 0), 0, 0.1); near(response(fc, cents, 0), -3.01, 1);
  near(response(10000, 13500, 0), 0, 0.01, "bypass");
});

test("test_G13_nonRealtimeGeneratorsFixedAtNoteOn", () => {
  const b = B.single(B.sine(100, 4410), { loop: [0, 4410], instGens: [[Gen.sampleModes, 1]], instMods: [{ src: 0x0082, dest: 56, amount: -128 }] });
  const r = new SpecRender(b);
  r.cc(2, 64); r.noteOn(72);
  near(A.cents(A.f0ZeroCrossing(r.render(22050).l, sr, 2000), 1000), 12 * 36, 1);
  r.cc(2, 0);
  near(A.cents(A.f0ZeroCrossing(r.render(22050).l, sr, 2000), 1000), 12 * 36, 1, "fixed at note-on");
  for (const g of [43, 44, 46, 47, 54, 56, 57, 58]) assert.equal(genInfo(g)!.realtime, false, `${g}`);
});

test("test_S09_loopSanityPolicy", () => {
  const region = (loop: [number, number]) => new SF2SoundFont(B.single(B.dc(100), { loop, instGens: [[Gen.sampleModes, 1]] }).build(), STRICT).buildRegionsForPreset(0)[0];
  assert.equal(region([50, 51]).sampleModes, 0); assert.equal(region([60, 40]).sampleModes, 0);
  const s = region([10, 20]);
  assert.equal(s.sampleModes, 1); assert.equal(s.sample.loopStart, 10); assert.equal(s.sample.loopEnd, 20);
  const r = new SpecRender(B.single(Array.from({ length: 100 }, (_, i) => i * 100), { loop: [10, 20], instGens: [[Gen.sampleModes, 1]] }));
  r.noteOn(60);
  const t = [...r.render(400).l.slice(200)].map(Math.abs);
  near(Math.min(...t) / Math.max(...t), 10 / 19, 0.01, "values 10...19 only");
});

test("test_S10_stereoPairsOneVoicePerZone", () => {
  const b = new B();
  b.samples = [...B.sine(100, 4410), ...new Array(46).fill(0), ...B.dc(4410, -8000), ...new Array(46).fill(0)];
  b.sampleHeaders = [{ name: "L", start: 0, end: 4410, loopStart: 0, loopEnd: 4410, link: 1, type: 4 },
    { name: "R", start: 4456, end: 8866, loopStart: 4456, loopEnd: 8866, link: 0, type: 2 }];
  b.instruments = [["st", [{ gens: [[Gen.sampleModes, 1]] }, { gens: [[Gen.pan, -500], [Gen.coarseTune, 12], [Gen.sampleID, 0]] }, { gens: [[Gen.pan, 500], [Gen.sampleID, 1]] }]]];
  b.presets = [["p", 0, 0, [{ gens: [[Gen.instrument, 0]] }]]];
  const r = new SpecRender(b); r.noteOn(60);
  assert.equal(r.engine.voiceCount, 2);
  const o = r.render(22050);
  near(A.cents(A.f0ZeroCrossing(o.l, sr, 2000), 1000), 0, 1, "left uses the right zone's pitch");
  assert.ok(Math.max(...o.r.slice(1000)) < 0);
  assert.ok(Math.abs(A.goertzel(o.r, 1000, sr, 2000, 19845)) < 1e-5);
  const bad = b.clone(); bad.sampleHeaders[1].type = 1;
  const m = new SpecRender(bad); m.noteOn(60);
  near(A.cents(A.f0ZeroCrossing(m.render(22050).l, sr, 2000), 2000), 0, 1, "invalid link -> mono");
  const lk = b.clone(); lk.sampleHeaders[0].type = 8; lk.sampleHeaders[1].type = 8;
  const k = new SpecRender(lk); k.noteOn(60);
  near(A.cents(A.f0ZeroCrossing(k.render(22050).l, sr, 2000), 2000), 0, 1, "linkedSample -> mono");
});

test("test_G11_effectsSends", () => {
  const wave = B.sine(100, 4410);
  const aux = (r: SpecRender, n: number) => { const x = Array.from({ length: 6 }, () => new Float32Array(n)); r.engine.renderRangeWithSends(x[0], x[1], x[2], x[3], x[4], x[5]); return x; };
  const r = new SpecRender(B.single(wave, { loop: [0, 4410], instGens: [[Gen.sampleModes, 1], [Gen.reverbEffectsSend, 500], [Gen.chorusEffectsSend, 250], [Gen.pan, -250]] }));
  r.cc(91, 0); r.cc(93, 0); r.noteOn(60);
  const b = aux(r, 8820);
  for (let i = 100; i < 8820; i += 97) {
    near(b[2][i], b[0][i] * 0.5, 1e-6); near(b[3][i], b[1][i] * 0.5, 1e-6);
    near(b[4][i], b[0][i] * 0.25, 1e-6); near(b[5][i], b[1][i] * 0.25, 1e-6);
  }
  assert.ok(A.rmsDB(b[2], 4410) > -40);
  const r2 = new SpecRender(B.single(wave, { loop: [0, 4410], instGens: [[Gen.sampleModes, 1]] }));
  r2.cc(91, 127); r2.cc(93, 64); r2.noteOn(60);
  const c = aux(r2, 4410);
  near(c[2][3000] / c[0][3000], 0.2 * 127 / 128, 1e-4); near(c[4][3000] / c[0][3000], 0.2 * 64 / 128, 1e-4);
  const dry = new SpecRender(B.single(wave, { loop: [0, 4410], instGens: [[Gen.sampleModes, 1]] }));
  dry.cc(91, 0); dry.cc(93, 0); dry.noteOn(60);
  near(A.rmsDB(aux(dry, 4410)[0], 2000), A.rmsDB(c[0], 2000), 1e-3, "sends never change dry");
  const tail = (on: boolean) => {
    const t = new SpecRender(B.single(wave, { loop: [0, 4410], instGens: [[Gen.sampleModes, 1], [Gen.reverbEffectsSend, 1000], [Gen.chorusEffectsSend, 1000], [Gen.releaseVolEnv, -6000]] }));
    t.engine.effectsEnabled = on;
    t.noteOn(60); t.render(8820); t.noteOff(60); t.render(22050);
    assert.equal(t.engine.voiceCount, 0);
    return A.rmsDB(t.render(4410).l);
  };
  assert.ok(tail(true) > -80); assert.ok(tail(false) < -200);
});
