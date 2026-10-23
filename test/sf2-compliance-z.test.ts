// Matrix rows Z-xx (sections 7.3 to 9.4, 10.6, 10.7), S-01/02/05/06/07 (samples), E-02...E-04.
import test from "node:test";
import assert from "node:assert/strict";
import { SF2SoundFont, SF2Error, STRICT, type SF2Region } from "../src/sf2/soundfont.ts";
import { GEN_TABLE, genInfo, genDefaultValue, valueRange } from "../src/sf2/geninfo.ts";
import { DEFAULT_MODS_201 } from "../src/sf2/modulator.ts";
import { SF2Builder as B, Gen, type BZone } from "./support/sf2-builder.ts";
import { SpecRender } from "./support/analysis.ts";

type G = [number, number][];
const spec = (b: B, p = 0): SF2Region[] => new SF2SoundFont(b.build(), STRICT).buildRegionsForPreset(p);
const merged = (b: B, p = 0) => new SF2SoundFont(b.build(), STRICT).specMergedGenerators(p);
function bank(inst: G[], preset: G[] = [[[Gen.instrument, 0]]]): B {
  const b = B.single(B.dc(100));
  b.instruments = [["i", inst.map((g): BZone => ({ gens: g }))]];
  b.presets = [["p", 0, 0, preset.map((g): BZone => ({ gens: g }))]];
  return b;
}

test("test_Z01_globalZoneDetectedByLastGenerator", () => {
  assert.deepEqual(spec(bank([[[Gen.pan, 100]], [[Gen.sampleID, 0]]])).map((r) => r.pan), [100]);
  assert.equal(spec(bank([[[Gen.pan, 100]]])).length, 0);
  assert.deepEqual(spec(bank([[[Gen.sampleID, 0]], [[Gen.pan, 300]], [[Gen.pan, 7], [Gen.sampleID, 0]]])).map((r) => r.pan), [0, 7]);
  assert.deepEqual(spec(bank([[[Gen.sampleID, 0]]], [[[Gen.pan, 50]], [[Gen.instrument, 0]]])).map((r) => r.pan), [50]);
});

test("test_Z02_generatorsAfterTerminalIgnored", () => {
  const r = spec(bank([[[Gen.sampleID, 0], [Gen.coarseTune, 5]]], [[[Gen.instrument, 0], [Gen.fineTune, 9]]]));
  assert.deepEqual(r.map((x) => x.coarseTune), [0]);
  assert.deepEqual(r.map((x) => x.fineTune), [0]);
});

test("test_Z03_rangeGeneratorPositionRules", () => {
  const r = spec(bank([
    [[Gen.pan, 1], [Gen.keyRange, 0x3c3c], [Gen.sampleID, 0]],
    [[Gen.keyRange, 0x4030], [Gen.velRange, 0x4010], [Gen.sampleID, 0]],
    [[Gen.coarseTune, 1], [Gen.velRange, 0x4010], [Gen.sampleID, 0]],
    [[Gen.velRange, 0x2010], [Gen.sampleID, 0]],
  ]));
  assert.deepEqual(r.map((x) => x.keyRange), [[0, 127], [48, 64], [0, 127], [0, 127]]);
  assert.deepEqual(r.map((x) => x.velRange), [[0, 127], [16, 64], [0, 127], [16, 32]]);
});

test("test_Z04_duplicateGeneratorLastWins", () => {
  assert.deepEqual(spec(bank([[[Gen.pan, 100], [Gen.pan, -200], [Gen.sampleID, 0]]])).map((r) => r.pan), [-200]);
});

test("test_Z05_incompleteZonesIgnored", () => {
  assert.equal(spec(bank([[], [[Gen.sampleID, 0]]])).length, 1);
  assert.deepEqual(spec(bank([[[Gen.sampleID, 0]]], [[[Gen.instrument, 0]], [[Gen.pan, 300]]])).map((r) => r.pan), [0]);
  const b = bank([[[Gen.sampleID, 0]]]); b.presets = [["empty", 0, 0, []]];
  assert.equal(spec(b).length, 0);
});

test("test_Z06_illegalIndexGeneratorsIgnored", () => {
  const m = merged(bank([[[Gen.instrument, 0], [Gen.pan, 4], [Gen.sampleID, 0]]], [[[Gen.sampleID, 0], [Gen.instrument, 0]]]));
  assert.equal(m.length, 1);
  assert.equal(m[0].get(Gen.instrument), undefined);
  assert.equal(m[0].get(Gen.pan), 4);
});

test("test_Z07_instrumentOnlyGeneratorsIgnoredInPresets", () => {
  const onlyInst = [0, 1, 2, 3, 4, 12, 45, 46, 47, 50, 54, 57, 58];
  const m = merged(bank([[[Gen.sampleID, 0]]], [[...onlyInst.map((g): [number, number] => [g, 3]), [Gen.instrument, 0]]]));
  for (const g of onlyInst) assert.equal(m[0].get(g), undefined, `gen ${g}`);
});

test("test_Z08_reservedGeneratorsIgnored", () => {
  const reserved = [14, 18, 19, 20, 42, 49, 55, 59, 60, 61, 99, 1000];
  const gs = reserved.map((g): [number, number] => [g, 5]);
  const m = merged(bank([[...gs, [Gen.sampleID, 0]]], [[...gs, [Gen.instrument, 0]]]));
  for (const g of reserved) assert.equal(m[0].get(g), undefined, `gen ${g}`);
});

test("test_Z09_presetRangesIntersect", () => {
  const r = spec(bank([[[Gen.keyRange, 0x5030], [Gen.sampleID, 0]], [[Gen.keyRange, 0x7f60], [Gen.sampleID, 0]]],
    [[[Gen.keyRange, 0x4028], [Gen.instrument, 0]]]));
  assert.equal(r.length, 1, "second zone 96..127 does not intersect 40..64");
  assert.deepEqual(r[0].keyRange, [48, 64]);
});

test("test_Z10_presetAddsToInstrumentOrDefault", () => {
  let r = spec(bank([[[Gen.sampleID, 0]]], [[[Gen.attackVolEnv, 2400], [Gen.instrument, 0]]]));
  assert.equal(r[0].volEnv.attackTc, -9600);
  r = spec(bank([[[Gen.attackVolEnv, 1200], [Gen.sampleID, 0]]], [[[Gen.attackVolEnv, 2400], [Gen.instrument, 0]]]));
  assert.equal(r[0].volEnv.attackTc, 3600);
  r = spec(bank([[[Gen.coarseTune, 10]], [[Gen.coarseTune, 2], [Gen.sampleID, 0]]],
    [[[Gen.coarseTune, 40]], [[Gen.coarseTune, 3], [Gen.instrument, 0]]]));
  assert.equal(r[0].coarseTune, 5);
});

test("test_Z11_genInfoTableAndClamp", () => {
  assert.equal(GEN_TABLE.length, 61);
  for (const id of [14, 18, 19, 20, 42, 49, 55, 59, 60]) assert.equal(genInfo(id), null);
  assert.equal(genDefaultValue(Gen.initialFilterFc), 13500);
  assert.equal(genDefaultValue(Gen.scaleTuning), 100);
  assert.equal(genDefaultValue(Gen.overridingRootKey), -1);
  for (let id = 0; id <= 70; id++) {
    const g = genInfo(id), r = valueRange(id);
    if (g && g.kind === "value") assert.deepEqual(r, [g.min, g.max], `${id}`); else assert.equal(r, null, `${id}`);
  }
  const r = spec(bank([[[Gen.initialAttenuation, 1400], [Gen.pan, 400], [Gen.fineTune, 99], [Gen.coarseTune, -120],
    [Gen.sustainVolEnv, 1440], [Gen.initialFilterQ, 900], [Gen.sampleID, 0]]],
  [[[Gen.initialAttenuation, 100], [Gen.pan, 300], [Gen.fineTune, 50], [Gen.coarseTune, -10],
    [Gen.sustainVolEnv, 200], [Gen.initialFilterQ, 200], [Gen.instrument, 0]]]));
  assert.equal(r[0].initialAttenuationCb, 1440);
  assert.equal(r[0].pan, 500);
  assert.equal(r[0].fineTune, 99);
  assert.equal(r[0].coarseTune, -120);
  assert.equal(r[0].volEnv.sustainCb, 1440);
  assert.equal(r[0].initialFilterQCb, 960);
});

test("test_Z12_presetResolution", () => {
  const b = bank([[[Gen.sampleID, 0]]]);
  const z = b.presets[0][3];
  b.presets = [["first", 3, 0, z], ["dup", 3, 0, z], ["p200", 200, 0, z], ["b200", 4, 200, z], ["drum", 4, 128, z]];
  const sf = new SF2SoundFont(b.build(), STRICT);
  assert.equal(sf.resolvePresetIndex(3, 0), 0, "first (preset, bank) is active");
  assert.equal(sf.presets.length, 5, "unplayable presets are kept");
  assert.equal(sf.resolvePresetIndex(200, 0), null, "wPreset > 127 never playable");
  assert.equal(sf.resolvePresetIndex(4, 200), 4, "bank > 128 never playable; falls back (engine policy)");
  assert.equal(sf.isPlayable(3), false); assert.equal(sf.isPlayable(4), true);
});

// ── S-01/02/05/06/07 ──

const sf = (b: B) => new SF2SoundFont(b.build(), STRICT);

test("test_S01_specDoesNotNormalize", () => {
  assert.equal(sf(B.single(B.dc(100, 8192))).regionList(0)[0].sample.dataL[10], 0.25, "raw 8192 / 32768");
});

test("test_S05_unpitchedOriginalKey", () => {
  for (const p of [128, 200, 255]) assert.equal(sf(B.single(B.dc(100), { pitch: p })).buildRegionsForPreset(0)[0].originalKey, 60, `pitch ${p}`);
  assert.equal(sf(B.single(B.dc(100), { pitch: 72 })).buildRegionsForPreset(0)[0].originalKey, 72);
});

test("test_S06_overridingRootKeyMinusOneUsesHeader", () => {
  let r = sf(B.single(B.dc(100), { pitch: 64, instGens: [[Gen.overridingRootKey, -1]] })).buildRegionsForPreset(0);
  assert.equal(r[0].overridingRootKey, null);
  assert.equal(r[0].originalKey, 64);
  r = sf(B.single(B.dc(100), { pitch: 64, instGens: [[Gen.overridingRootKey, 69]] })).buildRegionsForPreset(0);
  assert.equal(r[0].overridingRootKey, 69);
});

test("test_S07_pitchCorrection", () => {
  const b = B.single(B.dc(100)); b.sampleHeaders[0].corr = -4;
  assert.equal(sf(b).buildRegionsForPreset(0)[0].fineTune, -4, "7.10 example: -4 cents");
});

test("test_S02_samplePointsOutOfRange", () => {
  const b = B.single(B.dc(100)); b.sampleHeaders[0].end = 5000;
  assert.throws(() => sf(b), (e: unknown) => e instanceof SF2Error && e.structural?.rule === "samplePointsOutOfRange" && e.structural.sample === 0);
  assert.equal(new SF2SoundFont(b.build()).buildRegionsForPreset(0).length, 0, "lenient: silent");
  const e = B.single(B.dc(100)); e.sampleHeaders[0].end = 0;
  assert.throws(() => sf(e));
  assert.equal(new SF2SoundFont(e.build()).buildRegionsForPreset(0).length, 0);
});

// ── E-02...E-04 ──

test("test_E02_unknownEnumeratorsIgnored", () => {
  const b = B.single(B.dc(100), { instGens: [[99, 5], [61, 1], [Gen.pan, 10]], presetGens: [[200, 7]],
    instMods: [{ src: 0x0081, dest: 99, amount: 5 }, { src: 0x0055, dest: 48, amount: 5 }] });
  const f = sf(b);
  const r = f.buildRegionsForPreset(0);
  assert.equal(r.length, 1);
  assert.equal(r[0].pan, 10);
  assert.deepEqual(r[0].modulators, DEFAULT_MODS_201, "unknown modulators dropped, defaults kept");
  assert.equal(f.specMergedGenerators(0)[0].get(99), undefined);
});

test("test_E03_illegalValues", () => {
  let r = sf(B.single(B.dc(100), { pitch: 200, instGens: [[Gen.overridingRootKey, 300]] })).buildRegionsForPreset(0)[0];
  assert.equal(r.overridingRootKey, null); assert.equal(r.originalKey, 60);
  r = sf(B.single(B.dc(100), { instGens: [[Gen.initialFilterFc, 100], [Gen.scaleTuning, 5000], [Gen.decayVolEnv, 20000]] })).buildRegionsForPreset(0)[0];
  assert.equal(r.initialFilterFcCents, 1500); assert.equal(r.scaleTuning, 1200); assert.equal(r.volEnv.decayTc, 8000);
});

test("test_E04_missingTerminatorIgnoresZone", () => {
  const b = B.single(B.dc(400), { loop: [10, 390], instGens: [[Gen.keyRange, 0x3c30], [Gen.sampleModes, 1]] });
  b.instruments[0][1].push({ gens: [[Gen.keyRange, 0x7f50]] });
  const r = new SpecRender(b);
  r.noteOn(100);
  assert.equal(r.engine.voiceCount, 0, "note-on ignored");
  r.noteOn(50);
  assert.equal(r.engine.voiceCount, 1);
});
