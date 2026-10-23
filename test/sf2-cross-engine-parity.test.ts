// Cross-engine parity: gbk JS (this repo) vs sf2player-swift `.spec` (= `.gbk`) via its sf2-parity-render tool.
// The test runs when SF2_PARITY_SWIFT_BIN points at a built sf2-parity-render binary (e.g.
// `swift build -c release --product sf2-parity-render` in sf2player-swift, branch sf2-201-gbk-sync); otherwise it is skipped.
// Tolerance: max |JS - Swift| <= 1e-6 per sample (Float32 output). Observed on Linux: <= 2.4e-10, most scenarios bit-exact;
// the residue is libm ulp differences (V8 fdlibm vs glibc) in pow/exp/sin/tanh.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderScenario, type Scenario } from "../src/sf2/parity.ts";
import { SF2Builder as B, Gen } from "./support/sf2-builder.ts";

const BIN = process.env.SF2_PARITY_SWIFT_BIN;
const GU = resolve("public/static/GeneralUser-GS.sf2");
const TOL = 1e-6;
const skip = !BIN || !existsSync(BIN) ? "SF2_PARITY_SWIFT_BIN not set" : false;
const dir = skip ? "" : mkdtempSync(join(tmpdir(), "sf2-parity-"));

function compare(s: Scenario & { name: string }): number {
  const js = renderScenario(s, (p) => new Uint8Array(readFileSync(p)));
  const sc = join(dir, `${s.name}.json`), out = join(dir, `${s.name}.f32`);
  writeFileSync(sc, JSON.stringify(s));
  execFileSync(BIN!, [sc, out]);
  const b = readFileSync(out);
  const sw = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  assert.equal(sw.length, js.left.length * 2, `${s.name}: length`);
  let m = 0, peak = 0;
  for (let i = 0; i < js.left.length; i++) {
    m = Math.max(m, Math.abs(js.left[i] - sw[2 * i]), Math.abs(js.right[i] - sw[2 * i + 1]));
    peak = Math.max(peak, Math.abs(js.left[i]));
  }
  assert.ok(peak > 1e-4, `${s.name}: silent render proves nothing`);
  assert.ok(m <= TOL, `${s.name}: max diff ${m}`);
  return m;
}

test("parity: GeneralUser GS scenarios (programs, CCs, bend, pressure, sustain, fx, drums, master bus)", { skip: skip || (!existsSync(GU) && "no GU") }, () => {
  const list = JSON.parse(readFileSync("test/parity/gu-scenarios.json", "utf8")) as (Scenario & { name: string })[];
  let worst = 0;
  for (const s of list) worst = Math.max(worst, compare({ ...s, font: GU }));
  console.log(`GU parity: ${list.length} scenarios, worst ${worst}`);
});

test("parity: builder fixture banks", { skip }, () => {
  const banks: [string, B][] = [
    ["sine-env", B.single(B.sine(100, 4410), { loop: [0, 4410], instGens: [[Gen.sampleModes, 1], [Gen.attackVolEnv, -2400], [Gen.decayVolEnv, -1200], [Gen.sustainVolEnv, 300], [Gen.releaseVolEnv, -2400]] })],
    ["filter-lfo", B.single(B.noise(8000), { loop: [100, 7900], instGens: [[Gen.sampleModes, 1], [Gen.initialFilterFc, 7000], [Gen.initialFilterQ, 120], [Gen.modLfoToFilterFc, 2400], [Gen.vibLfoToPitch, 50], [Gen.modEnvToPitch, 300]] })],
    ["mods", B.single(B.sine(50, 4410), { loop: [0, 4410], instGens: [[Gen.sampleModes, 1]], instMods: [{ src: 0x0082, dest: Gen.initialFilterFc, amount: -2400 }, { src: 0x020d, dest: Gen.pan, amount: 400 }] })],
    ["exclusive-unlooped", B.single(B.ramp(3000), { instGens: [[Gen.exclusiveClass, 3], [Gen.scaleTuning, 50], [Gen.reverbEffectsSend, 700], [Gen.chorusEffectsSend, 400]] })],
  ];
  for (const [name, b] of banks) {
    const font = join(dir, `${name}.sf2`);
    writeFileSync(font, b.build());
    const events: Scenario["events"] = [
      { frame: 0, type: "noteOn", channel: 0, note: 60, velocity: 100 },
      { frame: 2000, type: "controlChange", channel: 0, controller: 2, value: 90 },
      { frame: 3000, type: "noteOn", channel: 0, note: 67, velocity: 127 },
      { frame: 5000, type: "pitchBend", channel: 0, velocity: 3000 },
      { frame: 6000, type: "controlChange", channel: 0, controller: 13, value: 127 },
      { frame: 9000, type: "noteOff", channel: 0, note: 60 },
      { frame: 12000, type: "noteOff", channel: 0, note: 67 },
    ];
    for (const fx of [false, true]) compare({ name: `${name}-${fx}`, font, frames: 20000, effects: fx, strict: true, tracks: [{ trackIndex: 0, preset: 0 }], events: events.map((e) => ({ ...e, trackIndex: 0 })) });
  }
});
