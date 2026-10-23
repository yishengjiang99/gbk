// Analytic measurements on rendered audio (spec behaviour is asserted by measuring, not snapshots).
// Mirror of sf2player-swift Tests/SF2EngineTests/Analysis.swift.
import { SF2SoundFont, STRICT } from "../../src/sf2/soundfont.ts";
import { Sf2SynthEngine } from "../../src/sf2-renderer.ts";
import type { SF2Builder } from "./sf2-builder.ts";

type Buf = ArrayLike<number>;
export const Analysis = {
  db(x: number): number { return 20 * Math.log10(Math.max(x, 1e-12)); },
  rmsDB(x: Buf, from = 0, count?: number): number {
    const n = Math.min(count ?? x.length - from, x.length - from);
    if (n <= 0) return -240;
    let s = 0;
    for (let i = from; i < from + n; i++) s += x[i] * x[i];
    return Analysis.db(Math.sqrt(s / n));
  },
  envelopeDB(x: Buf, window: number): number[] {
    const out: number[] = [];
    for (let i = 0; i + window <= x.length; i += window) out.push(Analysis.rmsDB(x, i, window));
    return out;
  },
  peakDB(x: Buf, from = 0, count?: number): number {
    const n = Math.min(count ?? x.length - from, x.length - from);
    let p = 0;
    for (let i = from; i < from + n; i++) p = Math.max(p, Math.abs(x[i]));
    return Analysis.db(p);
  },
  f0ZeroCrossing(x: Buf, sampleRate: number, from = 0, count?: number): number {
    const n = Math.min(count ?? x.length - from, x.length - from);
    const times: number[] = [];
    for (let i = from + 1; i < from + n; i++) {
      if (x[i - 1] < 0 && x[i] >= 0) { const a = x[i - 1], b = x[i]; times.push(i - 1 + -a / (b - a)); }
    }
    if (times.length < 2) return 0;
    return ((times.length - 1) * sampleRate) / (times[times.length - 1] - times[0]);
  },
  f0Autocorrelation(x: Buf, sampleRate: number, from = 0, count = 8192, minHz = 20, maxHz = 5000): number {
    const n = Math.min(count, x.length - from);
    const minLag = Math.max(1, Math.trunc(sampleRate / maxHz)), maxLag = Math.min(Math.trunc(n / 2), Math.trunc(sampleRate / minHz));
    if (!(maxLag > minLag + 2)) return 0;
    const rs: number[] = [];
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i < n - lag; i++) s += x[from + i] * x[from + i + lag];
      rs.push(s / (n - lag));
    }
    const gmax = Math.max(...rs);
    let k = rs.findIndex((v, i) => i > 0 && i < rs.length - 1 && v >= rs[i - 1] && v >= rs[i + 1] && v > 0.9 * gmax);
    if (k <= 0) k = Math.max(1, rs.indexOf(gmax));
    k = Math.max(1, Math.min(rs.length - 2, k));
    const a = rs[k - 1], b = rs[k], c = rs[k + 1];
    const off = a - 2 * b + c === 0 ? 0 : (0.5 * (a - c)) / (a - 2 * b + c);
    return sampleRate / (minLag + k + off);
  },
  cents(f: number, ref: number): number { return 1200 * Math.log2(f / ref); },
  goertzel(x: Buf, freq: number, sampleRate: number, from = 0, count?: number): number {
    const n = Math.min(count ?? x.length - from, x.length - from);
    const w = (2 * Math.PI * freq) / sampleRate, coeff = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = from; i < from + n; i++) { const s0 = x[i] + coeff * s1 - s2; s2 = s1; s1 = s0; }
    const re = s1 - s2 * Math.cos(w), im = s2 * Math.sin(w);
    return (2 * Math.sqrt(re * re + im * im)) / n / (freq === 0 ? 2 : 1);
  },
  lrRatioDB(l: Buf, r: Buf, from = 0, count?: number): number {
    return Analysis.rmsDB(l, from, count) - Analysis.rmsDB(r, from, count);
  },
  firstCrossing(x: Buf, thresholdDB: number, rising: boolean, window = 16, from = 0): number | null {
    for (let i = from; i + window <= x.length; i += window) {
      const lv = Analysis.peakDB(x, i, window);
      if (rising ? lv >= thresholdDB : lv <= thresholdDB) return i;
    }
    return null;
  },
};

/** Renders notes from an in-memory bank (strict load, track 0). */
export class SpecRender {
  readonly engine: Sf2SynthEngine;
  readonly sf: SF2SoundFont;
  constructor(b: SF2Builder, preset = 0, readonly sampleRate = 44100, maxVoices = 64) {
    this.sf = new SF2SoundFont(b.build(), STRICT);
    this.engine = new Sf2SynthEngine(sampleRate, { maxVoices });
    // Compliance measurements are of the SF2 synthesis model, so they bypass the non-normative master bus.
    this.engine.masterDynamicsEnabled = false;
    this.engine.masterGainDb = 0;
    this.engine.setTrackStates([{ trackIndex: 0, regions: this.sf.regionList(preset) }]);
  }
  noteOn(key = 60, velocity = 127, channel = 0): void { this.engine.dispatchEvent({ type: "noteOn", note: key, velocity, trackIndex: 0, channel }); }
  noteOff(key = 60, channel = 0): void { this.engine.dispatchEvent({ type: "noteOff", note: key, trackIndex: 0, channel }); }
  cc(c: number, v: number, channel = 0): void { this.engine.dispatchEvent({ type: "controlChange", controller: c, value: v, trackIndex: 0, channel }); }
  render(frames: number): { l: Float32Array; r: Float32Array } {
    const l = new Float32Array(frames), r = new Float32Array(frames);
    this.engine.renderRange(l, r);
    return { l, r };
  }
  seconds(s: number): number { return Math.round(s * this.sampleRate); }
}
