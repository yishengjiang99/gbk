// Master bus (non-normative; there is no SF2 2.01 counterpart): gain, compressor, limiter, safety clip.
import test from "node:test";
import assert from "node:assert/strict";
import { MasterBus, MASTER_BUS_DEFAULTS } from "../src/sf2/master-bus.ts";
import { Sf2SynthEngine } from "../src/sf2-renderer.ts";
import { SF2SoundFont, STRICT } from "../src/sf2/soundfont.ts";
import { SF2Builder as B, Gen } from "./support/sf2-builder.ts";
import { Analysis as A } from "./support/analysis.ts";

const SR = 44100;
const ceiling = Math.pow(10, MASTER_BUS_DEFAULTS.ceilingDb / 20);

function engineFor(b: B, opts: { dyn?: boolean; gainDb?: number } = {}) {
  const sf = new SF2SoundFont(b.build(), STRICT);
  const e = new Sf2SynthEngine(SR, { maxVoices: 64 });
  if (opts.dyn !== undefined) e.masterDynamicsEnabled = opts.dyn;
  if (opts.gainDb !== undefined) e.masterGainDb = opts.gainDb;
  e.setTrackStates([{ trackIndex: 0, regions: sf.regionList(0) }]);
  return e;
}
const loudBank = () => B.single(B.sine(100, 4410, 32000), { loop: [0, 4410],
  instGens: [[Gen.sampleModes, 1], [Gen.reverbEffectsSend, 1000], [Gen.chorusEffectsSend, 1000]] });
function render(e: Sf2SynthEngine, n: number) { const l = new Float32Array(n), r = new Float32Array(n); e.renderRange(l, r); return { l, r }; }

test("master: defaults are -3 dB gain, -6 dBFS / 4:1 / 6 dB knee / 5 ms / 100 ms, ceiling -0.3 dBFS, 50 ms limiter release", () => {
  const e = new Sf2SynthEngine(SR);
  assert.equal(e.masterGainDb, -3);
  assert.equal(e.masterDynamicsEnabled, true);
  assert.deepEqual({ ...e.master.params }, { thresholdDb: -6, ratio: 4, kneeDb: 6, attackMs: 5, releaseMs: 100, ceilingDb: -0.3, limiterReleaseMs: 50, lookaheadMs: 1.5 });
  assert.equal(e.master.latencyFrames, Math.round(1.5e-3 * SR));
});

test("master: dense loud chord with fx stays <= ceiling and never reaches 1.0", () => {
  for (const gainDb of [-3, 0, 12, 40]) {
    const e = engineFor(loudBank(), { gainDb });
    for (let k = 36; k < 84; k++) e.dispatchEvent({ type: "noteOn", note: k, velocity: 127, trackIndex: 0, channel: 0 });
    const o = render(e, SR);
    let m = 0;
    for (let i = 0; i < SR; i++) { m = Math.max(m, Math.abs(o.l[i]), Math.abs(o.r[i])); assert.ok(Number.isFinite(o.l[i]) && Number.isFinite(o.r[i])); }
    assert.ok(m <= Math.fround(ceiling), `gain ${gainDb}: peak ${m}`);
    assert.ok(m < 1);
    if (gainDb >= 12) assert.ok(m > 0.9, "limiter is actually working near the ceiling");
  }
  // control: without the master stage the same chord exceeds full scale
  const off = engineFor(loudBank(), { dyn: false, gainDb: 0 });
  for (let k = 36; k < 84; k++) off.dispatchEvent({ type: "noteOn", note: k, velocity: 127, trackIndex: 0, channel: 0 });
  assert.ok(A.peakDB(render(off, SR).l) > 0);
});

test("master: quiet signals below threshold pass at master gain only (within 0.01 dB)", () => {
  const quiet = () => B.single(B.sine(100, 4410, 600), { loop: [0, 4410], instGens: [[Gen.sampleModes, 1]] });
  const on = engineFor(quiet()), ref = engineFor(quiet(), { dyn: false, gainDb: 0 });
  for (const e of [on, ref]) e.dispatchEvent({ type: "noteOn", note: 60, velocity: 127, trackIndex: 0, channel: 0 });
  const a = render(on, SR), b = render(ref, SR);
  assert.ok(A.peakDB(b.l) < -20);
  assert.ok(Math.abs(A.rmsDB(a.l, 22050, 8820) - A.rmsDB(b.l, 22050, 8820) - -3) < 0.01);
  const d = on.master.latencyFrames;
  for (let i = 10000; i < 10100; i++) assert.ok(Math.abs(a.l[i] - b.l[i - d] * Math.pow(10, -3 / 20)) < 1e-6, "sample-exact apart from latency");
});

test("master: compressor attack and release time constants within 2%", () => {
  for (const [att, rel] of [[5, 100], [20, 300]]) {
    const m = new MasterBus(SR, { attackMs: att, releaseMs: rel, lookaheadMs: 0 });
    for (let i = 0; i < SR; i++) m.process(0.01, 0.01);
    const target = MasterBus.reductionDb(0, -6, 4, 6);
    assert.ok(Math.abs(target - 4.5) < 1e-12);
    let i = 0;
    while (m.compressorReductionDb < (1 - Math.exp(-1)) * target) { m.process(1, -1); i++; }
    assert.ok(Math.abs(i / SR * 1000 - att) / att < 0.02, `attack ${i / SR * 1000} ms`);
    for (let k = 0; k < SR; k++) m.process(1, -1);
    i = 0;
    while (m.compressorReductionDb > Math.exp(-1) * target) { m.process(0.01, 0.01); i++; }
    assert.ok(Math.abs(i / SR * 1000 - rel) / rel < 0.02, `release ${i / SR * 1000} ms`);
  }
});

test("master: limiter is brickwall with instant attack, 50 ms release, and lookahead delay", () => {
  const m = new MasterBus(SR, { thresholdDb: 0, ratio: 1 });
  const la = m.latencyFrames;
  const out: number[] = [];
  for (let i = 0; i < SR; i++) { m.process(i >= 1000 && i < 1010 ? 4 : 0.5, 0); out.push(m.outL); }
  for (const v of out) assert.ok(Math.abs(v) <= ceiling);
  assert.ok(out[1000 + la] > 0.9 * ceiling, "the spike is limited, not deleted");
  assert.ok(Math.abs(out[1000 + la - 1] - 0.5 * ceiling / 4) < 1e-12, "gain already down before the spike (lookahead)");
  const after = 1010 + la;
  const tgt = 0.5, g0 = ceiling / 4;
  const t63 = out.findIndex((v, i) => i > after && v >= 0.5 * (g0 + (1 - g0) * (1 - Math.exp(-1))));
  assert.ok(Math.abs((t63 - after) / SR * 1000 - 50) / 50 < 0.02, `limiter release ${(t63 - after) / SR * 1000} ms`);
  assert.ok(Math.abs(out[SR - 1] - tgt) < 1e-6, "fully recovered");
});

test("master: gain reduction recovers after a loud hit", () => {
  const m = new MasterBus(SR);
  for (let i = 0; i < 4410; i++) m.process(3, 3);
  assert.ok(m.gainReductionDb > 6);
  for (let i = 0; i < 3 * SR; i++) m.process(0.05, 0.05);
  assert.ok(m.gainReductionDb === 0, `${m.gainReductionDb}`);
  assert.ok(Math.abs(m.outL - 0.05) < 1e-9);
});

test("master: no NaN, Inf or denormals; safety clip bounded by the ceiling", () => {
  const m = new MasterBus(SR);
  const inputs = [NaN, Infinity, -Infinity, 1e300, -1e300, 1e-320, -5e-324, 0, 1e5];
  for (let k = 0; k < 2000; k++) {
    const x = inputs[k % inputs.length];
    m.process(x, -x);
    assert.ok(Number.isFinite(m.outL) && Number.isFinite(m.outR));
    assert.ok(Math.abs(m.outL) <= ceiling && Math.abs(m.outR) <= ceiling);
  }
  for (let i = 0; i < 10 * SR; i++) m.process(1e-310, 1e-310);
  assert.ok(m.compressorReductionDb === 0 && m.gainReductionDb === 0, "state flushed to exact zero");
  for (const c of [ceiling, 0.5, 0.999]) for (const x of [0, 0.1, 0.89 * c, c, 2, 1e9, -1e9]) {
    const y = MasterBus.softClip(x, c);
    assert.ok(Math.abs(y) <= c && Math.abs(y) < 1);
    if (Math.abs(x) <= 0.9 * c) assert.equal(y, x);
  }
  assert.equal(MasterBus.softClip(NaN, ceiling), 0);
});

test("master: misconfiguration cannot reach 1.0 (ratio 1, no limiter release, +60 dB)", () => {
  const e = engineFor(loudBank(), { gainDb: 60 });
  e.master.setParams({ ratio: 1, limiterReleaseMs: 0, lookaheadMs: 0, ceilingDb: 5 });
  for (let k = 48; k < 72; k++) e.dispatchEvent({ type: "noteOn", note: k, velocity: 127, trackIndex: 0, channel: 0 });
  const o = render(e, 22050);
  for (let i = 0; i < 22050; i++) assert.ok(Math.abs(o.l[i]) < 1 && Math.abs(o.r[i]) < 1);
});

test("master: renderScheduled applies the same stage as renderRange", () => {
  const a = engineFor(loudBank()), b = engineFor(loudBank());
  const evs = [{ type: "noteOn" as const, note: 60, velocity: 127, trackIndex: 0, channel: 0, frame: 0 }];
  a.dispatchEvent(evs[0]);
  const x = render(a, 4096);
  const l = new Float32Array(4096), r = new Float32Array(4096);
  b.renderScheduled(l, r, evs);
  assert.deepEqual(l, x.l); assert.deepEqual(r, x.r);
});
