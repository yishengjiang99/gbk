// App track controllers (CC7 volume, CC10 pan, CC11 expression) must reach the audio through the
// channel controller state and the 2.01 default modulators (8.4.5 / 8.4.6 / 8.4.7), not a gain hack.
import test from "node:test";
import assert from "node:assert/strict";
import { Sf2SynthEngine } from "../src/sf2-renderer.ts";
import { SF2SoundFont, STRICT } from "../src/sf2/soundfont.ts";
import { SF2Builder as B, Gen } from "./support/sf2-builder.ts";

const SR = 44100;
const bank = () => B.single(B.sine(100, 4410, 16000), { loop: [0, 4410], instGens: [[Gen.sampleModes, 1]] });
const regions = () => new SF2SoundFont(bank().build(), STRICT).regionList(0);

function engine(): Sf2SynthEngine {
  const e = new Sf2SynthEngine(SR, { maxVoices: 16 });
  e.masterDynamicsEnabled = false; e.masterGainDb = 0; e.effectsEnabled = false;
  return e;
}
/** RMS dB of L and R over 4096 frames after an 8192-frame settle. */
function measure(e: Sf2SynthEngine): { l: number; r: number } {
  const n = 8192 + 4096, L = new Float32Array(n), R = new Float32Array(n);
  e.renderRange(L, R);
  const db = (x: Float32Array) => { let s = 0; for (let i = 8192; i < n; i++) s += x[i] * x[i]; return 10 * Math.log10(s / 4096 + 1e-30); };
  return { l: db(L), r: db(R) };
}
function trackRender(cc: { cc7Volume?: number; cc10Pan?: number; cc11Expression?: number }, channel = 3) {
  const e = engine();
  e.setTrackStates([{ trackIndex: 0, regions: regions(), ...cc }]);
  e.dispatchEvent({ type: "noteOn", trackIndex: 0, channel, note: 60, velocity: 127 });
  return { e, m: measure(e) };
}
/** Default negative concave CC7 / CC11 -> 960 cB: x = (127 - v)/128, 96 dB * concave(x) = 40*log10(128/(v+1)) dB. */
const attDb = (v: number) => 40 * Math.log10(128 / (v + 1));
const concaveDb = (v: number) => attDb(v) - attDb(127);

test("track CC7 sets level through the CC7 -> attenuation default modulator", () => {
  const full = trackRender({ cc7Volume: 127 }).m;
  for (const v of [100, 64, 32]) {
    const m = trackRender({ cc7Volume: v }).m;
    assert.ok(Math.abs((full.l - m.l) - concaveDb(v)) < 0.1, `cc7=${v}: drop ${full.l - m.l} vs ${concaveDb(v)}`);
  }
  assert.ok(trackRender({ cc7Volume: 0 }).m.l < full.l - 80, "cc7=0 is ~84 dB down");
});

test("track CC11 sets level through the CC11 -> attenuation default modulator and stacks with CC7", () => {
  const full = trackRender({ cc7Volume: 127, cc11Expression: 127 }).m;
  const m = trackRender({ cc7Volume: 127, cc11Expression: 64 }).m;
  assert.ok(Math.abs((full.l - m.l) - concaveDb(64)) < 0.1);
  const both = trackRender({ cc7Volume: 64, cc11Expression: 64 }).m;
  assert.ok(Math.abs((full.l - both.l) - 2 * concaveDb(64)) < 0.2);
});

test("track CC10 pans through the CC10 -> pan default modulator", () => {
  const c = trackRender({ cc10Pan: 64 }).m;
  assert.ok(Math.abs(c.l - c.r) < 0.2, "center");
  const left = trackRender({ cc10Pan: 0 }).m, right = trackRender({ cc10Pan: 127 }).m;
  assert.ok(left.l - left.r > 30, `left ${left.l} ${left.r}`);
  assert.ok(right.r - right.l > 30, `right ${right.l} ${right.r}`);
});

test("live setControllers changes a sounding track voice (track-indexed and engine-wide)", () => {
  const { e, m: before } = trackRender({ cc7Volume: 127 });
  e.dispatchEvent({ type: "setControllers", trackIndex: 0, cc7Volume: 64 });
  const after = measure(e);
  assert.ok(Math.abs((before.l - after.l) - concaveDb(64)) < 0.3, `${before.l - after.l}`);
  e.dispatchEvent({ type: "setControllers", trackIndex: 0, cc10Pan: 0 });
  const panned = measure(e);
  assert.ok(panned.l - panned.r > 30);

  const g = engine();
  g.setTrackStates([{ trackIndex: 0, regions: regions() }]);
  g.dispatchEvent({ type: "noteOn", trackIndex: 0, channel: 5, note: 60, velocity: 127 });
  g.dispatchEvent({ type: "setControllers", cc7Volume: 127 });
  const a = measure(g);
  g.dispatchEvent({ type: "setControllers", cc11Expression: 64 });
  const b = measure(g);
  g.dispatchEvent({ type: "setControllers", cc10Pan: 127 });
  const c = measure(g);
  assert.equal(g.controller(7, 5), 127); assert.equal(g.controller(11, 9), 64);
  assert.ok(Math.abs((a.r - b.r) - concaveDb(64)) < 0.3, `${a.r - b.r}`);
  assert.ok(c.r - c.l > 30);
});

test("tracks without explicit CCs leave in-stream channel CCs alone", () => {
  const e = engine();
  e.setTrackStates([{ trackIndex: 0, regions: regions() }]);
  e.dispatchEvent({ type: "controlChange", channel: 2, controller: 7, value: 40 });
  e.dispatchEvent({ type: "noteOn", trackIndex: 0, channel: 2, note: 60, velocity: 127 });
  assert.equal(e.controller(7, 2), 40);
  const d = engine();
  d.setTrackStates([{ trackIndex: 0, regions: regions(), cc7Volume: 100, cc10Pan: 64, cc11Expression: 127 }]);
  d.dispatchEvent({ type: "controlChange", channel: 2, controller: 7, value: 40 });
  d.dispatchEvent({ type: "noteOn", trackIndex: 0, channel: 2, note: 60, velocity: 127 });
  assert.equal(d.controller(7, 2), 40, "explicit power-on defaults do not clobber in-stream CC7");
});
