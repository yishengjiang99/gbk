// Matrix rows MIDI-02..08, N-xx, M-11, G-02, G-12. Ported from sf2player-swift ComplianceMIDITests.
import test from "node:test";
import assert from "node:assert/strict";
import { SF2SoundFont, STRICT } from "../src/sf2/soundfont.ts";
import { Sf2SynthEngine, type Sf2Voice } from "../src/sf2-renderer.ts";
import { SF2Builder as B, Gen, type BMod } from "./support/sf2-builder.ts";
import { Analysis as A, SpecRender } from "./support/analysis.ts";

const RELEASE = 6;
const near = (a: number, b: number, tol: number, msg = "") => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const held = (extra: [number, number][] = [], mods: BMod[] = []) =>
  B.single(B.dc(4000), { loop: [100, 3900], instGens: [[Gen.sampleModes, 1], [Gen.releaseVolEnv, -2400], ...extra], instMods: mods });
const voices = (r: SpecRender): Sf2Voice[] => Array.from({ length: r.engine.voiceCount }, (_, i) => r.engine.debugVoice(i)!);
const releasing = (r: SpecRender) => voices(r).map((v) => v.volEnv.stage === RELEASE);
const ev = (r: SpecRender, e: Record<string, unknown>) => r.engine.dispatchEvent({ trackIndex: 0, channel: 0, ...e } as never);

test("test_MIDI02_sustainPedal", () => {
  const r = new SpecRender(held());
  r.noteOn(60); r.cc(64, 127); r.noteOff(60);
  assert.deepEqual(releasing(r), [false]);
  r.cc(64, 0);
  assert.deepEqual(releasing(r), [true]);
});

test("test_MIDI03_sostenuto", () => {
  const r = new SpecRender(held());
  r.noteOn(60); r.cc(67, 127); r.noteOn(62); r.noteOff(60); r.noteOff(62);
  assert.deepEqual(voices(r).map((v) => v.note), [60, 62]);
  assert.deepEqual(releasing(r), [false, true]);
  r.cc(64, 127); r.cc(64, 0);
  assert.equal(releasing(r)[0], false);
  r.cc(67, 0);
  assert.equal(releasing(r)[0], true);
});

test("test_MIDI04_softPedal", () => {
  const r = new SpecRender(held([[Gen.initialFilterFc, 9000]]));
  r.noteOn(60); r.cc(66, 127); r.noteOn(62);
  const v = voices(r);
  near(v[1].initialFc, v[0].initialFc - Sf2SynthEngine.softPedalFcCents, 1e-9);
  near(A.db(v[1].baseGain / v[0].baseGain), -Sf2SynthEngine.softPedalAttenuationCb / 10, 0.01);
});

test("test_MIDI05_allSoundOffAllNotesOff", () => {
  let r = new SpecRender(held());
  r.noteOn(60); r.noteOn(64); r.cc(64, 127); r.cc(123, 0);
  assert.deepEqual(releasing(r), [false, false], "CC123 respects sustain");
  r.cc(64, 0);
  assert.deepEqual(releasing(r), [true, true]);
  r = new SpecRender(held());
  r.noteOn(60); r.cc(64, 127); r.cc(67, 127); r.cc(120, 0);
  assert.equal(r.render(1).l[0], 0);
  assert.equal(r.engine.voiceCount, 0);
});

test("test_MIDI06_resetAllControllers", () => {
  const r = new SpecRender(held());
  r.noteOn(60); r.cc(64, 127); r.cc(1, 90); ev(r, { type: "channelPressure", value: 80 });
  for (const [c, v] of [[99, 120], [98, 48], [38, 0], [6, 80]]) r.cc(c, v);
  assert.notEqual(r.engine.debugNrpn(0, 48), 0);
  r.noteOff(60); r.cc(121, 0);
  assert.equal(r.engine.controller(64, 0), 0); assert.equal(r.engine.controller(1, 0), 0);
  assert.equal(r.engine.debugChannel(0).pressure, 0);
  assert.equal(r.engine.debugNrpn(0, 48), 0, "N-06");
  assert.deepEqual(releasing(r), [true]);
  assert.equal(r.engine.controller(7, 0), 100, "volume untouched (RP-015)");
});

test("test_MIDI07_programChange", () => {
  const b = held();
  b.instruments.push(["i2", [{ gens: [[Gen.sampleModes, 1], [Gen.pan, 300], [Gen.sampleID, 0]] }]]);
  b.presets = [["a", 0, 0, [{ gens: [[Gen.instrument, 0]] }]], ["b", 5, 0, [{ gens: [[Gen.instrument, 1]] }]],
    ["b8", 5, 8, [{ gens: [[Gen.pan, -100], [Gen.instrument, 1]] }]], ["drums", 0, 128, [{ gens: [[Gen.pan, -400], [Gen.instrument, 1]] }]]];
  const r = new SpecRender(b);
  r.engine.loadPrograms(new SF2SoundFont(b.build(), STRICT));
  ev(r, { type: "programChange", program: 5 }); r.noteOn(60);
  assert.equal(voices(r).slice(-1)[0].regPan, 300);
  r.cc(0, 8); ev(r, { type: "programChange", program: 5 }); r.noteOn(61);
  assert.equal(voices(r).slice(-1)[0].regPan, 200, "bank select at next program change");
  ev(r, { type: "programChange", program: 0, channel: 9 }); r.noteOn(62, 127, 9);
  assert.equal(voices(r).slice(-1)[0].regPan, -100, "channel 10 -> bank 128");
});

test("test_MIDI08_dataEntryRouting", () => {
  const r = new SpecRender(held());
  for (const [c, v] of [[101, 0], [100, 0], [6, 7]]) r.cc(c, v);
  assert.equal(r.engine.pitchBendRange(0), 7);
  for (const [c, v] of [[99, 120], [98, 17], [6, 9]]) r.cc(c, v);
  assert.equal(r.engine.pitchBendRange(0), 7);
  assert.notEqual(r.engine.debugNrpn(0, 17), 0);
  for (const [c, v] of [[101, 0], [100, 0], [6, 3]]) r.cc(c, v);
  assert.equal(r.engine.pitchBendRange(0), 3);
  assert.equal(r.engine.debugNrpn(0, 17), ((9 << 7) - 8192) * Sf2SynthEngine.nrpnScale(17));
});

test("test_N01_nrpnMode", () => {
  const r = new SpecRender(held());
  for (const [c, v] of [[99, 1], [98, 48], [6, 80]]) r.cc(c, v);
  assert.equal(r.engine.debugNrpn(0, 48), 0);
  for (const [c, v] of [[99, 120], [98, 48], [6, 80]]) r.cc(c, v);
  assert.notEqual(r.engine.debugNrpn(0, 48), 0);
});

test("test_N02_nrpnSelectAccumulator", () => {
  const r = new SpecRender(held());
  r.cc(99, 120);
  for (const v of [100, 100, 50]) r.cc(98, v);
  assert.equal(r.engine.debugChannel(0).nrpnSelect, -1);
  r.cc(98, 51); assert.equal(r.engine.debugChannel(0).nrpnSelect, 51);
  r.cc(98, 101); r.cc(98, 103); r.cc(98, 8); assert.equal(r.engine.debugChannel(0).nrpnSelect, 51);
  r.cc(98, 8); assert.equal(r.engine.debugChannel(0).nrpnSelect, 8);
});

test("test_N03_nrpnIllegalSelect", () => {
  const r = new SpecRender(held());
  r.cc(99, 120); r.cc(98, 48);
  for (const g of [Gen.sampleID, Gen.keyRange, Gen.overridingRootKey, Gen.scaleTuning, Gen.startAddrsOffset, 14, 59]) {
    r.cc(98, g);
    assert.equal(r.engine.debugChannel(0).nrpnSelect, 48, `gen ${g}`);
  }
  assert.ok(r.engine.debugChannel(0).nrpnActive);
});

test("test_N04_nrpnDataEntryAdds", () => {
  const r = new SpecRender(held());
  r.noteOn(60);
  const g0 = voices(r)[0].baseGain;
  for (const [c, v] of [[99, 120], [98, 48], [38, (8192 + 100) & 127], [6, (8192 + 100) >> 7]]) r.cc(c, v);
  near(A.db(voices(r)[0].baseGain / g0), -10, 0.01, "sounding voice");
  r.noteOn(64);
  near(A.db(voices(r)[1].baseGain / g0), -10, 0.01, "future voice");
  r.cc(38, 0); r.cc(6, 64);
  near(voices(r)[0].baseGain, g0, 1e-12);
  const s = new SpecRender(B.single(B.sine(100, 4410), { loop: [0, 4410], instGens: [[Gen.sampleModes, 1]] }));
  s.noteOn(60);
  for (const [c, v] of [[99, 120], [98, 52], [38, (8192 + 50) & 127], [6, (8192 + 50) >> 7]]) s.cc(c, v);
  near(A.cents(A.f0ZeroCrossing(s.render(22050).l, 44100, 2000), 1000), 50, 1);
});

test("test_N05_nrpnRange", () => {
  for (const [g, k] of [[48, 1], [8, 2], [6, 4], [34, 4], [22, 4], [17, 1]]) assert.equal(Sf2SynthEngine.nrpnScale(g), k, `gen ${g}`);
  const r = new SpecRender(held());
  for (const [c, v] of [[99, 120], [98, 8], [38, 0], [6, 0]]) r.cc(c, v);
  assert.equal(r.engine.debugNrpn(0, 8), -8192 * 2);
  r.cc(38, 127); r.cc(6, 127);
  assert.equal(r.engine.debugNrpn(0, 8), 8191 * 2);
});

test("test_N06_resetClearsNrpn", () => {
  const r = new SpecRender(held());
  for (const [c, v] of [[99, 120], [98, 17], [6, 90]]) r.cc(c, v);
  r.cc(121, 0);
  assert.equal(r.engine.debugNrpn(0, 17), 0);
  assert.equal(r.engine.debugChannel(0).nrpnActive, false);
});

test("test_M11_liveSources", () => {
  const r = new SpecRender(held([], [{ src: 0x000d, dest: 48, amount: 128 }, { src: 0x000a, dest: 17, amount: 128 }, { src: 0x0003, dest: 8, amount: -1280 }]));
  r.noteOn(60);
  ev(r, { type: "channelPressure", value: 64 });
  const g64 = voices(r)[0].baseGain;
  ev(r, { type: "channelPressure", value: 0 });
  near(A.db(g64 / voices(r)[0].baseGain), -6.4, 0.01, "channel pressure 64 -> 64 cB");
  ev(r, { type: "polyPressure", note: 60, value: 127 });
  near(voices(r)[0].regionPanPos, 127 / 500, 1e-9);
  ev(r, { type: "polyPressure", note: 61, value: 0 });
  near(voices(r)[0].regionPanPos, 127 / 500, 1e-9, "other keys");
  near(voices(r)[0].initialFc, 13500 - 1280 * 60 / 128, 1e-9, "key source");
});

test("test_G02_keynumVelocitySubstitution", () => {
  const r = new SpecRender(B.single(B.sine(100, 4410), { loop: [0, 4410], instGens: [[Gen.sampleModes, 1], [Gen.keynum, 72], [Gen.velocity, 64]] }));
  r.noteOn(48, 127);
  near(A.cents(A.f0ZeroCrossing(r.render(22050).l, 44100, 2000), 2000), 0, 1);
  const ref = new SpecRender(B.single(B.sine(100, 4410), { loop: [0, 4410], instGens: [[Gen.sampleModes, 1]] }));
  ref.noteOn(60, 64);
  near(voices(r)[0].baseGain, voices(ref)[0].baseGain, 1e-12);
  r.noteOff(48);
  assert.deepEqual(releasing(r), [true]);
});

test("test_G12_exclusiveClassFastReleaseSamePresetChannel", () => {
  const r = new SpecRender(B.single(B.dc(4000), { loop: [100, 3900], instGens: [[Gen.sampleModes, 1], [Gen.exclusiveClass, 5], [Gen.releaseVolEnv, 2400]] }));
  r.noteOn(42); r.render(441);
  r.noteOn(42, 127, 1); r.noteOn(46);
  assert.deepEqual(releasing(r), [true, false, false]);
  r.render(441);
  assert.equal(r.engine.voiceCount, 2);
});
