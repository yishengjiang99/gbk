// Track output stage (engine): the per-track orchestra pan + fader that used to be a
// StereoPannerNode -> GainNode pair per player track now runs inside Sf2SynthEngine, after the
// master bus. These tests pin the equivalence against the Web Audio formulas the nodes
// implemented: the stereo-input StereoPanner law (stereoPanGains, the same pure function the
// offline renderer applies) and the fader's setTargetAtTime exponential (tau = 10 ms).
import test from "node:test";
import assert from "node:assert/strict";
import { Sf2SynthEngine } from "../src/sf2-renderer.ts";
import { SF2SoundFont, STRICT } from "../src/sf2/soundfont.ts";
import { SF2Builder as B, Gen } from "./support/sf2-builder.ts";
import { stereoPanGains } from "../src/audio/orchestra-pan.ts";

const SR = 44100;

/** Stereo-diverse content: track 0 voices land hard-left, track 1 hard-right (per-voice track pan). */
function stereoEngine(): Sf2SynthEngine {
  const bankA = B.single(B.sine(100, 4410, 12000), { loop: [0, 4410], instGens: [[Gen.sampleModes, 1]] });
  const bankB = B.single(B.sine(57, 4410, 9000), { loop: [0, 4410], instGens: [[Gen.sampleModes, 1]] });
  const regsA = new SF2SoundFont(bankA.build(), STRICT).regionList(0);
  const regsB = new SF2SoundFont(bankB.build(), STRICT).regionList(0);
  const e = new Sf2SynthEngine(SR, { maxVoices: 16 });
  e.masterDynamicsEnabled = false;
  e.masterGainDb = 0;
  e.effectsEnabled = false;
  e.setTrackStates([
    { trackIndex: 0, regions: regsA, pan: -1 },
    { trackIndex: 1, regions: regsB, pan: 1 },
  ]);
  e.dispatchEvent({ type: "noteOn", trackIndex: 0, channel: 0, note: 60, velocity: 127 });
  e.dispatchEvent({ type: "noteOn", trackIndex: 1, channel: 0, note: 64, velocity: 127 });
  return e;
}

function render(e: Sf2SynthEngine, n: number) {
  const l = new Float32Array(n), r = new Float32Array(n);
  e.renderRange(l, r);
  return { l, r };
}

test("track stage: defaults and explicit identity are bit-exact", () => {
  const a = render(stereoEngine(), 4096);
  const e2 = stereoEngine();
  e2.trackPan = 0;
  e2.trackFader = 1;
  const b = render(e2, 4096);
  assert.deepEqual(b.l, a.l);
  assert.deepEqual(b.r, a.r);
  // the fixture really is stereo-diverse (otherwise the pan tests below prove nothing)
  let diff = 0;
  for (let i = 2048; i < 4096; i++) diff = Math.max(diff, Math.abs(a.l[i] - a.r[i]));
  assert.ok(diff > 0.05, `L/R diversity ${diff}`);
});

test("track stage: pan applies the StereoPanner stereo-input law (stereoPanGains)", () => {
  const ref = render(stereoEngine(), 8192);
  for (const pan of [-1, -0.35, 0.3, 0.65, 1]) {
    const e = stereoEngine();
    e.trackPan = pan;
    const out = render(e, 8192);
    const g = stereoPanGains(pan);
    for (let i = 0; i < 8192; i++) {
      const el = ref.l[i] * g.ll + ref.r[i] * g.rl;
      const er = ref.l[i] * g.lr + ref.r[i] * g.rr;
      assert.ok(Math.abs(out.l[i] - el) < 2e-6, `pan ${pan} frame ${i} L: ${out.l[i]} vs ${el}`);
      assert.ok(Math.abs(out.r[i] - er) < 2e-6, `pan ${pan} frame ${i} R: ${out.r[i]} vs ${er}`);
    }
  }
});

test("track stage: fader follows the setTargetAtTime exponential (tau 10 ms) and lands exactly", () => {
  const fader = (50 / 100) ** 2; // the player's (volume/100)^2 law, applied by the caller
  const ref = render(stereoEngine(), 16384);
  const e = stereoEngine();
  e.trackFader = fader;
  const out = render(e, 16384);
  const coef = Math.exp(-1 / (0.01 * SR));
  for (let i = 0; i < 16384; i++) {
    // frame i is the (i+1)-th one-pole step from the initial value 1
    const g = fader + (1 - fader) * Math.pow(coef, i + 1);
    assert.ok(Math.abs(out.l[i] - ref.l[i] * g) < 2e-5, `frame ${i} L: ${out.l[i]} vs ${ref.l[i] * g}`);
    assert.ok(Math.abs(out.r[i] - ref.r[i] * g) < 2e-5, `frame ${i} R: ${out.r[i]} vs ${ref.r[i] * g}`);
  }
  assert.equal(e.trackFader, fader);
  assert.equal(e.trackFaderCurrent, fader); // snapped exactly, like a settled AudioParam
});

test("track stage: pan and fader compose (fold-down at hard pan, scaled by the fader)", () => {
  const e = stereoEngine();
  e.trackPan = -1;
  e.trackFader = 0.5;
  render(e, 16384); // settle the fader to exactly 0.5
  const out = render(e, 4096);
  // reference engine of the same age (identical deterministic voice trajectory), no track stage
  const x = stereoEngine();
  render(x, 16384);
  const ref = render(x, 4096);
  for (let i = 0; i < 4096; i++) {
    assert.ok(Math.abs(out.r[i]) < 1e-9, `frame ${i}: hard-left fold leaves R silent`);
    assert.ok(Math.abs(out.l[i] - (ref.l[i] + ref.r[i]) * 0.5) < 2e-6, `frame ${i} L fold`);
  }
});

test("track stage: mute (fader 0) silences the output after the ramp", () => {
  const e = stereoEngine();
  e.trackFader = 0;
  const out = render(e, 16384);
  let tail = 0;
  for (let i = 12000; i < 16384; i++) tail = Math.max(tail, Math.abs(out.l[i]), Math.abs(out.r[i]));
  assert.equal(tail, 0);
  assert.equal(e.trackFaderCurrent, 0);
});
