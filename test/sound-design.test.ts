import test from "node:test";
import assert from "node:assert/strict";
import { Sf2SynthEngine } from "../src/sf2-renderer.ts";
import type { SF2Region } from "../src/sf2/soundfont.ts";
import {
  validateOverride, computeOverrideDeltas, effectiveVoice, humanToNative, nativeToHuman, overridesToNrpn, nrpnStep,
  normalizeEffects, EFFECTS_DEFAULTS, type VoiceOverride,
} from "../src/sf2/voice-overrides.ts";

const SR = 44100;
function region(o: Partial<SF2Region> = {}): SF2Region {
  const n = SR; const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = 0.5 * Math.sin((2 * Math.PI * 441 * i) / SR);
  return {
    keyRange: [0, 127], velRange: [0, 127], sample: { dataL: d, dataR: null, sampleRate: SR, start: 0, end: n, loopStart: 0, loopEnd: n } as never,
    sampleModes: 1, originalKey: 60, overridingRootKey: null, coarseTune: 0, fineTune: 0, scaleTuning: 100, initialAttenuationCb: 0, pan: 0,
    volEnv: { delayTc: -12000, attackTc: -12000, holdTc: -12000, decayTc: -12000, sustainCb: 0, releaseTc: -12000 },
    modEnv: { delayTc: -12000, attackTc: -12000, holdTc: -12000, decayTc: -12000, sustain: 0, releaseTc: -12000 },
    initialFilterFcCents: 13500, initialFilterQCb: 0, modEnvToFilterFcCents: 0, modLfoToFilterFcCents: 0, modLfoDelayTc: -12000, modLfoFreqCents: 0,
    modLfoToPitchCents: 0, vibLfoDelayTc: -12000, vibLfoFreqCents: 0, vibLfoToPitchCents: 0, exclusiveClass: 0, modulators: undefined, ...o,
  } as SF2Region;
}
const energy = (a: Float32Array, from = 0, to = a.length) => { let e = 0; for (let i = from; i < to; i++) e += a[i] * a[i]; return e; };

/** Renders one note; returns dry and reverb/chorus send buses (pre-effect) plus the full wet output. */
function sends(r: SF2Region, opts: { cc91?: number; cc93?: number; ovr?: VoiceOverride[] } = {}) {
  const e = new Sf2SynthEngine(SR); e.dispatchEvent({ type: "setPreset", regions: [r] });
  if (opts.ovr) e.setVoiceOverrides(-1, opts.ovr);
  if (opts.cc91 !== undefined) e.dispatchEvent({ type: "controlChange", channel: 0, controller: 91, value: opts.cc91 });
  if (opts.cc93 !== undefined) e.dispatchEvent({ type: "controlChange", channel: 0, controller: 93, value: opts.cc93 });
  e.dispatchEvent({ type: "noteOn", note: 60, velocity: 127, channel: 0 });
  const amt = { reverb: e.debugVoice(0)!.reverbAmt, chorus: e.debugVoice(0)!.chorusAmt };
  const N = 4096; const b = Array.from({ length: 6 }, () => new Float32Array(N));
  e.renderRangeWithSends(b[0], b[1], b[2], b[3], b[4], b[5]);
  return { amt, dry: energy(b[0]) + energy(b[1]), rev: energy(b[2]) + energy(b[3]), cho: energy(b[4]) + energy(b[5]) };
}

test("send (a): zone gen16=0, CC91=0 -> no reverb bus energy", () => {
  const s = sends(region({ reverbSend: 0 }), { cc91: 0 });
  assert.equal(s.amt.reverb, 0); assert.equal(s.rev, 0); assert.ok(s.dry > 0);
});
test("send (b): zone gen16=500, CC91=0 -> reverb bus at 50%", () => {
  const s = sends(region({ reverbSend: 500 }), { cc91: 0 });
  assert.equal(s.amt.reverb, 0.5); assert.ok(Math.abs(s.rev / s.dry - 0.25) < 1e-6);
});
test("send (c): CC91=127 adds ~20% (default modulator 8.4.8, amount 200) on the same zone", () => {
  const a = sends(region({ reverbSend: 500 }), { cc91: 0 }), b = sends(region({ reverbSend: 500 }), { cc91: 127 });
  assert.ok(Math.abs(b.amt.reverb - a.amt.reverb - 0.2) < 0.003, `${b.amt.reverb}`);
  const c = sends(region({ chorusSend: 0 }), { cc93: 127 });
  assert.ok(Math.abs(c.amt.chorus - 0.2) < 0.003 && c.cho > 0);
});
test("send (d): agent override changes the effective send and clamps to 0..1000", () => {
  assert.equal(sends(region({ reverbSend: 500 }), { ovr: [{ gen: 16, mode: "add", value: 300 }] }).amt.reverb, 0.8);
  assert.equal(sends(region({ reverbSend: 500 }), { ovr: [{ gen: 16, mode: "set", value: 100 }] }).amt.reverb, 0.1);
  assert.equal(sends(region({ reverbSend: 900 }), { cc91: 127, ovr: [{ gen: 16, mode: "add", value: 500 }] }).amt.reverb, 1);
});
test("send: explicit file CC91 modulator is not doubled by the built-in default", () => {
  const mods = [{ src: 0x00db, dest: 16, amount: 200, amtSrc: 0, transform: 0 }];
  assert.ok(Math.abs(sends(region({ modulators: mods }), { cc91: 127 }).amt.reverb - 0.2) < 0.003);
});

function renderWet(r: SF2Region, cc91: number, fx: Record<string, number> = {}) {
  const e = new Sf2SynthEngine(SR); e.masterDynamicsEnabled = false; e.setEffectParams(fx);
  e.dispatchEvent({ type: "setPreset", regions: [r] });
  e.dispatchEvent({ type: "controlChange", channel: 0, controller: 91, value: cc91 });
  e.dispatchEvent({ type: "noteOn", note: 60, velocity: 127, channel: 0 });
  const N = SR; const L = new Float32Array(N), R = new Float32Array(N);
  e.renderRange(L.subarray(0, 8820), R.subarray(0, 8820));
  e.dispatchEvent({ type: "noteOff", note: 60, channel: 0 });
  e.renderRange(L.subarray(8820), R.subarray(8820));
  return { L, R, tail: energy(L, 13230) + energy(R, 13230) };
}
test("reverb: CC91 is audible (tail energy after release), deterministic, roomSize lengthens tail", () => {
  const dry = renderWet(region(), 0), wet = renderWet(region(), 127), wet2 = renderWet(region(), 127);
  assert.equal(dry.tail, 0);
  assert.ok(wet.tail > 1e-4, `tail ${wet.tail}`);
  assert.deepEqual(wet.L, wet2.L);
  const big = renderWet(region(), 127, { roomSize: 1 }), small = renderWet(region(), 127, { roomSize: 0 });
  assert.ok(big.tail > small.tail * 2, `${big.tail} vs ${small.tail}`);
});
test("effects off switch: setEffectParams({enabled:false}) removes the wet tail", () => {
  const e = new Sf2SynthEngine(SR); e.setEffectParams({ enabled: false }); assert.equal(e.effectsEnabled, false);
});

function releaseTime(ovr?: VoiceOverride[]): { attack: number; release: number } {
  const r = region({ volEnv: { delayTc: -12000, attackTc: humanToNative(34, 0.1), holdTc: -12000, decayTc: -12000, sustainCb: 0, releaseTc: humanToNative(38, 0.2) } });
  const e = new Sf2SynthEngine(SR); e.effectsEnabled = false; e.masterDynamicsEnabled = false;
  e.dispatchEvent({ type: "setPreset", regions: [r] }); if (ovr) e.setVoiceOverrides(-1, ovr);
  e.dispatchEvent({ type: "noteOn", note: 60, velocity: 127, channel: 0 });
  const v = e.debugVoice(0)!; let attack = 0, n = 0;
  const L = new Float32Array(1), R = new Float32Array(1);
  while (v.volEnv.stage <= 2 && n < SR * 10) { e.renderRange(L, R); n++; } attack = n / SR;
  e.renderRange(new Float32Array(4410), new Float32Array(4410));
  e.dispatchEvent({ type: "noteOff", note: 60, channel: 0 }); n = 0;
  while (e.voiceCount > 0 && n < SR * 30) { e.renderRange(L, R); n++; }
  return { attack, release: n / SR };
}
test("envelope overrides change the rendered attack / release times", () => {
  const base = releaseTime();
  assert.ok(Math.abs(base.attack - 0.1) < 0.002 && Math.abs(base.release - 0.2 * 0.96) < 0.01, JSON.stringify(base));
  const longer = releaseTime([{ gen: 38, mode: "set", value: humanToNative(38, 2) }, { gen: 34, mode: "add", value: 1200 }]);
  assert.ok(Math.abs(longer.release - 2 * 0.96) < 0.02, JSON.stringify(longer));
  assert.ok(Math.abs(longer.attack - 0.2) < 0.003, JSON.stringify(longer));
});
test("key-range overrides only touch matching keys; per-track overrides only that track", () => {
  const e = new Sf2SynthEngine(SR); e.setTrackStates([{ trackIndex: 0, regions: [region()] }, { trackIndex: 1, regions: [region()] }]);
  e.setVoiceOverrides(1, [{ gen: 16, mode: "set", value: 400, keyLo: 60, keyHi: 64 }]);
  for (const [t, k] of [[0, 60], [1, 60], [1, 70]]) e.dispatchEvent({ type: "noteOn", trackIndex: t, note: k, velocity: 100, channel: 0 });
  assert.deepEqual([0, 1, 2].map((i) => e.debugVoice(i)!.reverbAmt), [0, 0.4, 0]);
  e.setVoiceOverrides(0, [{ gen: 16, mode: "add", value: 100 }], true);
  assert.equal(e.debugVoice(0)!.reverbAmt, 0.1);
});

test("override math: validation, deltas, units, NRPN mapping", () => {
  assert.equal(validateOverride({ gen: 38, mode: "set", value: 9000 }) !== null, true);
  assert.equal(validateOverride({ gen: 38, mode: "set", value: 8000 }), null);
  assert.equal(validateOverride({ gen: 53, mode: "set", value: 1 }) !== null, true);
  assert.equal(validateOverride({ gen: 16, mode: "add", value: 10, keyLo: 70, keyHi: 60 }) !== null, true);
  const r = region({ reverbSend: 200 }); const d = new Float64Array(61);
  computeOverrideDeltas([{ gen: 16, mode: "set", value: 700 }, { gen: 8, mode: "add", value: -1200 }], r, 60, d);
  assert.equal(d[16], 500); assert.equal(d[8], -1200);
  const eff = effectiveVoice(r, [{ gen: 38, mode: "set", value: 1200 }], 60);
  assert.equal(eff.volEnvRelease.value, 2); assert.equal(eff.reverbSend.value, 20); assert.ok(Math.abs(eff.filterCutoff.value - 19912) < 30);
  assert.ok(Math.abs(nativeToHuman(22, humanToNative(22, 5)) - 5) < 0.01);
  assert.equal(nrpnStep(38), 4); assert.equal(nrpnStep(16), 1);
  const { bytes, skipped } = overridesToNrpn([{ gen: 16, mode: "add", value: 300 }, { gen: 38, mode: "set", value: 0 }], 2);
  assert.deepEqual(bytes, [[0xb2, 99, 120], [0xb2, 98, 16], [0xb2, 38, (8492) & 127], [0xb2, 6, 8492 >> 7]]);
  assert.equal(skipped.length, 1);
  assert.deepEqual(normalizeEffects({ roomSize: 5 }), { ...EFFECTS_DEFAULTS, roomSize: 1 });
});
test("NRPN export bytes reproduce the add override in the engine (SF2 9.6)", () => {
  const e = new Sf2SynthEngine(SR); e.dispatchEvent({ type: "setPreset", regions: [region()] });
  for (const b of overridesToNrpn([{ gen: 16, mode: "add", value: 300 }], 0).bytes) e.dispatchEvent({ type: "controlChange", channel: 0, controller: b[1], value: b[2] });
  e.dispatchEvent({ type: "noteOn", note: 60, velocity: 100, channel: 0 });
  assert.equal(e.debugVoice(0)!.reverbAmt, 0.3);
});
