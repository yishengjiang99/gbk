// Matrix rows M-xx: modulators (sections 7.4, 7.8, 8.2 to 8.4, 9.5). Ported from sf2player-swift ComplianceMTests.
import test from "node:test";
import assert from "node:assert/strict";
import { SF2SoundFont, STRICT } from "../src/sf2/soundfont.ts";
import { mod, modValue, mergeModulators, sameIdentity, defaultModulators, DEFAULT_MODS_201, PITCH_DEST, type SF2Modulator, type SF2SpecVersion } from "../src/sf2/modulator.ts";
import { SF2Builder as B, Gen } from "./support/sf2-builder.ts";
import { SpecRender } from "./support/analysis.ts";

const v201: SF2SpecVersion = { major: 2, minor: 1 }, v204: SF2SpecVersion = { major: 2, minor: 4 };
const near = (a: number, b: number, tol: number, msg = "") => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
function value(m: SF2Modulator, o: { cc?: Record<number, number>; velocity?: number; key?: number; wheel?: number } = {}): number {
  const cc = new Uint8Array(128);
  for (const [k, v] of Object.entries(o.cc ?? {})) cc[+k] = v;
  return modValue(m, { velocity: o.velocity ?? 100, key: o.key ?? 60, cc, ccBase: 0, pitchWheel: o.wheel ?? 8192, pitchWheelSensitivity: 2, channelPressure: 0, polyPressure: 0 });
}
const kept = (m: SF2Modulator, v: SF2SpecVersion) => mergeModulators([], [m], [], [], v).some((x) => sameIdentity(x, m) && x.amount === m.amount);

test("test_M01_sourceLayoutAndUnknownType", () => {
  assert.ok(kept(mod(0x0c81, 34, 10), v201), "type 3 switch");
  assert.ok(!kept(mod(0x1081, 34, 10), v201), "type 4 ignored");
  assert.ok(!kept(mod(0x0081, 34, 10, 0x8002), v201), "amount-source type > 3");
  near(value(mod(0x0081, 34, 128), { cc: { 1: 64 } }), 64, 1e-9);
  near(value(mod(0x0181, 34, 128), { cc: { 1: 63 } }), 64, 1e-9);
  near(value(mod(0x0281, 34, 128), { cc: { 1: 0 } }), -128, 1e-9);
});

test("test_M02_illegalSourcesIgnored", () => {
  for (const i of [1, 4, 5, 9, 11, 12, 15, 17, 127]) assert.ok(!kept(mod(i, 34, 10), v201), `general ${i}`);
  for (const i of [0, 2, 3, 10, 13, 14, 16]) assert.ok(kept(mod(i, 34, 10), v201), `general ${i}`);
  for (const c of [0, 6, 32, 38, 98, 99, 100, 101, 120, 127, 33, 63]) assert.ok(!kept(mod(0x80 | c, 34, 10), v201), `CC${c}`);
  for (const c of [1, 7, 31, 64, 97, 102, 119]) assert.ok(kept(mod(0x80 | c, 34, 10), v201), `CC${c}`);
});

test("test_M03_noControllerIsOne", () => {
  assert.equal(value(mod(0, 34, 100)), 100);
  near(value(mod(0x0081, 34, 128, 0), { cc: { 1: 127 } }), 127, 1e-9);
});

test("test_M04_sourceMappingTable", () => {
  const concave = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : Math.min(1, -(20 / 96) * Math.log10((1 - x) * (1 - x))));
  const curve = (t: number, x: number) => (t === 1 ? concave(x) : t === 2 ? 1 - concave(1 - x) : t === 3 ? (x >= 0.5 ? 1 : 0) : x);
  const expected = (v: number, range: number, t: number, d: boolean, p: boolean) => {
    if (p) { const b0 = 2 * v / range - 1, b = d ? -b0 : b0; return (b < 0 ? -1 : 1) * curve(t, Math.abs(b)); }
    return curve(t, d ? (range - 1 - v) / range : v / range);
  };
  for (let t = 0; t <= 3; t++) for (const d of [false, true]) for (const p of [false, true]) {
    const bits = (t << 10) | (d ? 0x100 : 0) | (p ? 0x200 : 0);
    for (const v of [0, 64, 127]) near(value(mod(bits | 0x81, 34, 1), { cc: { 1: v } }), expected(v, 128, t, d, p), 1e-12, `7-bit t${t} d${d} p${p} v${v}`);
    for (const v of [0, 8192, 16383]) near(value(mod(bits | 14, 34, 1), { wheel: v }), expected(v, 16384, t, d, p), 1e-12, `14-bit t${t} d${d} p${p} v${v}`);
  }
  assert.equal(value(mod(0x0081, 34, 1), { cc: { 1: 127 } }), 127 / 128);
  assert.equal(value(mod(0x0181, 34, 1), { cc: { 1: 0 } }), 127 / 128);
  assert.equal(value(mod(0x0181, 34, 1), { cc: { 1: 127 } }), 0);
  assert.equal(value(mod(0x0281, 34, 1), { cc: { 1: 64 } }), 0);
  assert.equal(value(mod(0x0281, 34, 1), { cc: { 1: 0 } }), -1);
});

test("test_M05_transformVersionGated", () => {
  const abs = mod(0x0081, 34, 10, 0, 2);
  assert.ok(!kept(abs, v201)); assert.ok(kept(abs, v204));
  assert.ok(!kept(mod(0x0081, 34, 10, 0, 1), v204));
  assert.equal(value(mod(0x0281, 34, 100, 0, 2), { cc: { 1: 0 } }), 100);
});

test("test_M06_destinationMustBeValueGenerator", () => {
  for (const d of [0, 1, 2, 3, 4, 12, 41, 43, 44, 45, 46, 47, 50, 53, 54, 57, 58, 14, 42, 60, 61, 100, 0x8001]) assert.ok(!kept(mod(0x0081, d, 10), v201), `dest ${d}`);
  for (const d of [5, 8, 9, 15, 16, 17, 21, 34, 37, 48, 51, 52, 56]) assert.ok(kept(mod(0x0081, d, 10), v201), `dest ${d}`);
});

test("test_M07_dest59Ignored", () => {
  assert.ok(PITCH_DEST >= 64);
  assert.ok(!kept(mod(0x0081, 59, 1200), v201));
  assert.ok(!kept(mod(0x0081, PITCH_DEST, 1200), v201));
  assert.ok(DEFAULT_MODS_201.some((m) => m.dest === PITCH_DEST));
});

test("test_M08_modulatorOutput", () => {
  near(value(mod(0x0081, 34, 1000, 0x0082), { cc: { 1: 64, 2: 32 } }), 1000 * 0.5 * 0.25, 1e-9);
});

test("test_M09_modulatorMergeRules", () => {
  const vel = mod(0x0502, 48, 960), a = mod(0x0081, 34, 100), a2 = mod(0x0081, 34, 300), b = mod(0x0082, 34, 50);
  const merge = (ig: SF2Modulator[], il: SF2Modulator[], pg: SF2Modulator[] = [], pl: SF2Modulator[] = []) => mergeModulators(ig, il, pg, pl, v201);
  const amounts = (l: SF2Modulator[], m: SF2Modulator) => l.filter((x) => sameIdentity(x, m)).map((x) => x.amount);
  assert.deepEqual(amounts(merge([mod(0x0502, 48, 480)], []), vel), [480]);
  assert.deepEqual(amounts(merge([a], [a2]), a), [300]);
  assert.equal(merge([a], [b]).length, DEFAULT_MODS_201.length + 2);
  assert.deepEqual(amounts(merge([], [a], [a2], [mod(0x0081, 34, 7)]), a), [107]);
  assert.deepEqual(amounts(merge([], [], [], [mod(0x0502, 48, 40)]), vel), [1000]);
  assert.equal(merge([], [], [], [b]).length, DEFAULT_MODS_201.length + 1);
  assert.ok(!sameIdentity(a, mod(0x0081, 34, 100, 0, 2)));
  const bank = B.single(B.dc(100), { instMods: [{ src: 0x81, dest: 34, amount: 10 }, { src: 0x81, dest: 34, amount: 20 }] });
  bank.ifil = [2, 1];
  const r = new SF2SoundFont(bank.build(), STRICT).buildRegionsForPreset(0);
  assert.deepEqual(amounts(r[0].modulators ?? [], a), [20]);
});

test("test_M10_defaultModulators201", () => {
  const d = defaultModulators(v201);
  assert.equal(d.length, 10);
  assert.deepEqual(d.map((m) => m.src), [0x0502, 0x0102, 0x000d, 0x0081, 0x0587, 0x028a, 0x058b, 0x00db, 0x00dd, 0x020e]);
  assert.deepEqual(d.map((m) => m.dest), [48, 8, 6, 6, 48, 17, 48, 16, 15, PITCH_DEST]);
  assert.deepEqual(d.map((m) => m.amount), [960, -2400, 50, 50, 960, 1000, 960, 200, 200, 12700]);
  assert.deepEqual(d.map((m) => m.amtSrc), [0, 0x0d02, 0, 0, 0, 0, 0, 0, 0, 0x0010]);
  assert.equal(defaultModulators(v204).length, 8);
  assert.equal(value(d[1], { velocity: 127 }), 0);
  near(value(d[1], { velocity: 1 }), -2400 * 126 / 128, 1e-9);
  const r = new SF2SoundFont(B.single(B.dc(100)).build(), STRICT).buildRegionsForPreset(0);
  assert.deepEqual(r[0].modulators, d);
});

test("test_M12_modulatedValuesReclamped", () => {
  const b = B.single(B.dc(400), { loop: [10, 390], instGens: [[Gen.sampleModes, 1], [Gen.initialFilterFc, 9000]],
    instMods: [{ src: 0x0081, dest: 8, amount: 20000 }, { src: 0x0082, dest: 8, amount: -32000 }] });
  const r = new SpecRender(b); r.noteOn(60);
  const fc = () => r.engine.debugVoice(0)!.initialFc;
  near(fc(), 9000, 1e-9);
  r.cc(1, 127); assert.equal(fc(), 13500);
  r.cc(1, 0); r.cc(2, 127); assert.equal(fc(), 1500);
});
