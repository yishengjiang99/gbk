// Matrix rows P-xx / E-01: RIFF and chunk structure (sections 3 to 7, 10.1, 10.2).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { SF2SoundFont, SF2Error, STRICT, type SF2StructuralError } from "../src/sf2/soundfont.ts";
import { has204Features } from "../src/sf2/modulator.ts";
import { SF2Builder as B, Gen } from "./support/sf2-builder.ts";

const bank = () => B.single(B.dc(100), { loop: [10, 90] });
function strictError(b: B): SF2StructuralError | undefined {
  try { new SF2SoundFont(b.build(), STRICT); } catch (e) {
    assert.ok(e instanceof SF2Error && e.kind === "structural", `unexpected ${e}`);
    return e.structural;
  }
  assert.fail("strict accepted");
}
const strictLoads = (b: B) => new SF2SoundFont(b.build(), STRICT);
const GU = "public/static/GeneralUser-GS.sf2";

test("test_P00_builderDefaultIsStrictValid", () => {
  const sf = strictLoads(bank());
  assert.deepEqual(sf.warnings, []);
  assert.deepEqual(sf.version, { major: 2, minor: 1 });
});

test("test_P01_riffSizeMustMatchFile", () => {
  const b = bank();
  b.mutate = (bytes) => { const n = bytes.length - 8 + 2; bytes.splice(4, 4, ...B.le32(n)); return bytes; };
  const len = b.bytes().length;
  assert.deepEqual(strictError(b), { rule: "riffSize", declared: len - 6, actual: len - 8 });
  assert.deepEqual(new SF2SoundFont(b.build()).warnings[0], { rule: "riffSize", declared: len - 6, actual: len - 8 });
  const t = bank();
  t.mutate = (bytes) => bytes.slice(0, -20);
  assert.ok(strictError(t));
});

test("test_P02_chunkOrderIsEnforced", () => {
  const b = bank(); b.topOrder = ["sdta", "INFO", "pdta"];
  assert.deepEqual(strictError(b), { rule: "chunkOrder", chunk: "RIFF" });
  const p = bank(); p.pdtaOrder = ["phdr", "pbag", "pgen", "pmod", "inst", "ibag", "imod", "igen", "shdr"];
  assert.deepEqual(strictError(p), { rule: "chunkOrder", chunk: "pdta" });
});

test("test_P03_unknownChunksIgnoredInInfoOnly", () => {
  const b = bank(); b.extraChunks = [["INFO", "IXYZ", [1, 2]]];
  strictLoads(b);
  for (const c of ["pdta", "sdta", "RIFF"]) {
    const x = bank(); x.extraChunks = [[c, "abcd", [0, 0]]];
    assert.deepEqual(strictError(x), { rule: "unknownChunk", chunk: "abcd", in: c }, c);
  }
});

test("test_P04_ifilMandatoryAndVersioned", () => {
  const b = bank(); b.ifil = null;
  assert.deepEqual(strictError(b), { rule: "missingChunk", chunk: "ifil" });
  b.ifilBytes = [2, 0, 1, 0, 0, 0];
  assert.deepEqual(strictError(b), { rule: "chunkSize", chunk: "ifil", size: 6 });
  b.ifilBytes = null; b.ifil = [3, 0];
  assert.deepEqual(strictError(b), { rule: "unsupportedVersion", major: 3, minor: 0 });
  b.ifil = [2, 10];
  const sf = strictLoads(b);
  assert.deepEqual(sf.version, { major: 2, minor: 10 });
  assert.ok(has204Features(sf.specVersion));
});

test("test_P05_infoStringRules", () => {
  const b = bank(); b.isng = null; b.info = [];
  let sf = strictLoads(b);
  assert.equal(sf.info.isng, "EMU8000", "5.2: missing isng -> EMU8000");
  assert.equal(sf.info.INAM, undefined, "5.3: missing INAM -> unavailable, not rejected");
  b.isng = "Unknown Engine";
  b.rawInfo = [["ICOP", [97, 98, 99]], ["ICMT", [97, 98, 99, 100]], ["IENG", [120, 0, ...new Array(300).fill(65)]], ["ICRD", [0x45, 0xe9, 0, 0]]];
  sf = strictLoads(b);
  assert.equal(sf.info.isng, "EMU8000");
  assert.equal(sf.info.ICOP, undefined); assert.equal(sf.info.ICMT, undefined); assert.equal(sf.info.IENG, undefined);
  assert.equal(sf.info.ICRD, "E\u00e9");
});

test("test_P06_romSamplesNeedIromAndNeverSound", () => {
  const b = bank();
  Object.assign(b.sampleHeaders[0], { type: 0x8001, start: 1_000_000, end: 1_000_100 });
  assert.deepEqual(strictError(b), { rule: "romSampleWithoutIROM", sample: 0 });
  b.irom = "1MGM"; b.iver = [1, 0];
  const sf = strictLoads(b);
  assert.equal(sf.info.iver, "1.0");
  assert.equal(sf.buildRegionsForPreset(0).length, 0);
  const v = bank(); v.rawInfo = [["iver", [1, 0, 0, 0, 0, 0]]];
  assert.equal(strictLoads(v).info.iver, undefined, "5.5: iver must be 4 bytes");
});

test("test_P07_smplOptionalEvenAndSm24Gated", () => {
  const b = new B(); b.omitSmpl = true;
  b.instruments = [["empty", []]];
  b.presets = [["p", 0, 0, [{ gens: [[Gen.instrument, 0]] }]]];
  assert.equal(strictLoads(b).samples.length, 0);
  const o = bank(); o.smplBytes = new Array(201).fill(0);
  o.sampleHeaders[0].end = 90; o.sampleHeaders[0].loopEnd = 80;
  assert.deepEqual(strictError(o), { rule: "oddSampleByteCount", size: 201 });
  const s = bank(); s.extraChunks = [["sdta", "sm24", new Array(146).fill(0)]];
  const s24 = strictLoads(s);
  assert.ok(s24.sm24);
  assert.equal(has204Features(s24.specVersion), false, "sm24 is a 2.04 feature: unused for ifil 2.01");
});

test("test_P08_recordSizeMultiples", () => {
  for (const table of ["ibag", "igen", "imod", "inst", "pbag", "pgen", "phdr", "pmod", "shdr"]) {
    const b = bank();
    let size = 0;
    b.tableEdit = (id, body) => { if (id === table) { body = [...body, 0, 0]; size = body.length; } return body; };
    b.bytes();
    assert.deepEqual(strictError(b), { rule: "recordSize", chunk: table, size }, table);
  }
});

test("test_P09_allNinePdtaChunksRequired", () => {
  for (const t of ["pmod", "imod", "pgen"]) {
    const b = bank(); b.omitTable = t;
    assert.deepEqual(strictError(b), { rule: "missingChunk", chunk: t }, t);
  }
  const b = bank(); b.omitTable = "pmod";
  assert.deepEqual(new SF2SoundFont(b.build()).warnings[0], { rule: "missingChunk", chunk: "pmod" }, "lenient: warning only");
});

test("test_P10_minimumRecordCounts", () => {
  const b = bank(); b.presets = [];
  assert.deepEqual(strictError(b), { rule: "tooFewRecords", chunk: "phdr", count: 1 });
  const i = new B(); i.samples = B.dc(10); i.instruments = []; i.presets = [["p", 0, 0, []]];
  assert.deepEqual(strictError(i), { rule: "tooFewRecords", chunk: "inst", count: 1 });
});

test("test_P11_indexConsistency", () => {
  const two = bank(); two.presets.push(["p2", 1, 0, two.presets[0][3]]);
  const m = two.clone();
  m.tableEdit = (id, body) => { if (id === "phdr") body.splice(24, 2, 2, 0); return body; };
  assert.deepEqual(strictError(m), { rule: "bagIndexNotMonotonic", chunk: "phdr", index: 1 });
  const g = bank(); g.tableEdit = (id, body) => (id === "pgen" ? [...body, 0, 0, 0, 0] : body);
  assert.deepEqual(strictError(g), { rule: "indexCountMismatch", chunk: "pgen", expected: 2, actual: 3 });
  const md = bank(); md.tableEdit = (id, body) => (id === "imod" ? [...body, ...new Array(10).fill(0)] : body);
  assert.deepEqual(strictError(md), { rule: "indexCountMismatch", chunk: "imod", expected: 1, actual: 2 });
  const bg = bank();
  bg.tableEdit = (id, body) => { if (id === "ibag") { body.splice(4, 2, 0, 0); body.splice(0, 2, 1, 0); } return body; };
  assert.deepEqual(strictError(bg), { rule: "bagIndexNotMonotonic", chunk: "igen", index: 1 });
});

test("test_P12_instrumentAndSampleReferencesInRange", () => {
  const b = bank(); b.presets[0][3][0].gens = [[Gen.instrument, 1]];
  assert.deepEqual(strictError(b), { rule: "instrumentOutOfRange", genIndex: 0, value: 1 });
  const s = bank(); s.instruments[0][1][0].gens = [[Gen.sampleID, 1]];
  assert.deepEqual(strictError(s), { rule: "sampleOutOfRange", genIndex: 0, value: 1 });
  assert.equal(new SF2SoundFont(s.build()).buildRegionsForPreset(0).length, 0, "lenient never plays the terminal EOS");
});

test("test_P13_terminalsNeverPlayedOrphansAndDuplicatesKept", () => {
  const b = bank();
  b.instruments.push(["orphan", [{ gens: [[Gen.sampleID, 0]] }]]);
  b.sampleHeaders.push({ name: "orphanS", start: 0, end: 50, loopStart: 0, loopEnd: 0 });
  b.presets.push(["p", 0, 0, b.presets[0][3]]);
  const sf = strictLoads(b);
  assert.equal(sf.presets.length, 2);
  assert.deepEqual(sf.presets.map((p) => p.presetName), ["p", "p"]);
  assert.throws(() => sf.buildRegionsForPreset(2), (e: unknown) => e instanceof SF2Error && e.kind === "presetIndexOutOfRange" && e.detail === 2);
});

test("test_E01_structuralErrorsNameRuleAndChunk", () => {
  const b = bank(); b.tableEdit = (id, body) => (id === "pgen" ? [...body, 0, 0] : body);
  assert.deepEqual(strictError(b), { rule: "recordSize", chunk: "pgen", size: 10 });
  try { new SF2SoundFont(b.build(), STRICT); } catch (e) { assert.match(String((e as Error).message), /recordSize\(chunk: pgen, size: 10\)/); }
  assert.ok(new SF2SoundFont(b.build()).warnings.some((w) => w.rule === "recordSize" && w.chunk === "pgen" && w.size === 10));
});

test("test_P04_generalUserGSLoadsStrict", { skip: !existsSync(GU) && "no GeneralUser-GS.sf2" }, () => {
  const sf = new SF2SoundFont(new Uint8Array(readFileSync(GU)), STRICT);
  assert.deepEqual(sf.version, { major: 2, minor: 1 });
  assert.deepEqual(sf.warnings, []);
  assert.equal(sf.info.INAM, "GeneralUser GS 2.0.2");
});
