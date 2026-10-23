// P-99: random mutations / truncations of fixture banks never throw a non-SF2Error, hang, or produce non-finite audio.
// Iterations: SF2_FUZZ_ITERATIONS (default 10000, as in the Swift suite). Seeded SplitMix64, same as sf2player-swift FuzzTests.
import test from "node:test";
import assert from "node:assert/strict";
import { SF2SoundFont, SF2Error, STRICT, LENIENT } from "../src/sf2/soundfont.ts";
import { Sf2SynthEngine } from "../src/sf2-renderer.ts";
import { SF2Builder as B, Gen } from "./support/sf2-builder.ts";

class SplitMix64 {
  constructor(private state: bigint) {}
  next(): bigint {
    const M = (1n << 64n) - 1n;
    this.state = (this.state + 0x9e3779b97f4a7c15n) & M;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M;
    return z ^ (z >> 31n);
  }
  int(n: number): number { return Number(this.next() % BigInt(n)); }
}

function fixtures(): number[][] {
  const a = B.single(B.sine(10, 441), { loop: [0, 441], instGens: [[Gen.sampleModes, 1], [Gen.pan, -200]], presetGens: [[Gen.coarseTune, 2]], instMods: [{ src: 0x0081, dest: 34, amount: 100 }] });
  a.instruments[0][1].unshift({ gens: [[Gen.attackVolEnv, -1200]] });
  const st = B.single(B.dc(200), { loop: [10, 190] });
  st.samples.push(...B.dc(246, -3000));
  st.sampleHeaders[0].link = 1; st.sampleHeaders[0].type = 4;
  st.sampleHeaders.push({ name: "R", start: 246, end: 446, loopStart: 256, loopEnd: 436, link: 0, type: 2 });
  st.instruments[0][1].push({ gens: [[Gen.pan, 500], [Gen.sampleID, 1]] });
  const multi = B.single(B.noise(300), { loop: [20, 280], instGens: [[Gen.keyRange, 0x4000], [Gen.exclusiveClass, 3]] });
  multi.presets.push(["drums", 0, 128, [{ gens: [[Gen.velRange, 0x7f40], [Gen.instrument, 0]], mods: [{ src: 0x0502, dest: 48, amount: 100 }] }]]);
  return [a.bytes(), st.bytes(), multi.bytes()];
}

function exercise(sf: SF2SoundFont, l: Float32Array, r: Float32Array): void {
  for (let p = 0; p < Math.min(sf.presets.length, 8); p++) {
    let list;
    try { list = sf.regionList(p); } catch (e) { if (e instanceof SF2Error) continue; throw e; }
    const e = new Sf2SynthEngine(44100, { maxVoices: 16 });
    e.setTrackStates([{ trackIndex: 0, regions: list }]);
    for (const k of [36, 60, 96]) e.dispatchEvent({ type: "noteOn", note: k, velocity: 100, trackIndex: 0, channel: 0 });
    e.renderRange(l, r);
    e.dispatchEvent({ type: "noteOff", note: 60, trackIndex: 0, channel: 0 });
    e.renderRange(l, r);
    for (let i = 0; i < l.length; i++) assert.ok(Number.isFinite(l[i]) && Number.isFinite(r[i]) && Math.abs(l[i]) < 1);
  }
}

test("test_P99_parserNeverCrashes", () => {
  const rng = new SplitMix64(0x5f2201n);
  const bases = fixtures();
  const iterations = Number(process.env.SF2_FUZZ_ITERATIONS ?? "") || 10_000;
  const l = new Float32Array(1024), r = new Float32Array(1024);
  let loaded = 0, rejected = 0;
  for (let it = 0; it < iterations; it++) {
    const bytes = [...bases[it % bases.length]];
    switch (rng.int(4)) {
      case 0: { const n = 1 + rng.int(4); for (let k = 0; k < n; k++) bytes[rng.int(bytes.length)] = Number(rng.next() & 0xffn); break; }
      case 1: { const at = rng.int(bytes.length), len = Math.min(bytes.length - at, 1 + rng.int(4)); for (let i = 0; i < len; i++) bytes[at + i] = [0x00, 0xff, 0x7f, 0x80][rng.int(4)]; break; }
      case 2: bytes.length -= rng.int(bytes.length); break;
      default: { const at = rng.int(bytes.length); if (rng.int(2) === 0) bytes.splice(at, 0, Number(rng.next() & 0xffn)); else bytes.splice(at, 1); }
    }
    for (const opts of [LENIENT, STRICT]) {
      let sf: SF2SoundFont;
      try { sf = new SF2SoundFont(new Uint8Array(bytes), opts); } catch (e) {
        assert.ok(e instanceof SF2Error, `iteration ${it}: non-SF2Error ${e}`); rejected++; continue;
      }
      loaded++;
      exercise(sf, l, r);
    }
  }
  assert.ok(loaded > 0 && rejected > 0, `loaded ${loaded} rejected ${rejected}`);
});
