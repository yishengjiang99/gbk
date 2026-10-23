// G-11 (8.1.2 #15/#16, 9.1.5): built-in reverb (Freeverb-style: 8 lowpass-feedback combs + 4 series
// allpasses per channel, Float32 math) and chorus (two quadrature-modulated delay lines). Mirrors
// sf2player-swift Sources/SF2Engine/SF2Effects.swift. All storage is allocated once; `process`
// allocates nothing.
const f = Math.fround;
const COMB_TUNING = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNING = [556, 441, 341, 225];
const STEREO_SPREAD = 23;

export class SF2Effects {
  readonly buf: Float32Array;
  readonly offs: Int32Array;
  readonly lens: Int32Array;
  readonly idx: Int32Array;
  readonly combStore = new Float32Array(16);
  chorusPhase = 0;
  readonly sr: number;
  roomFeedback = f(0.84);
  damp = f(0.2);
  reverbWet = f(0.35);
  chorusDepthSec = 0.004;
  chorusBaseSec = 0.012;
  chorusRateHz = 0.6;
  chorusWet = 0.7;
  outL = 0;
  outR = 0;

  constructor(sr: number) {
    this.sr = sr;
    const scale = sr / 44100;
    const lengths: number[] = [];
    for (let ch = 0; ch < 2; ch++) for (const t of COMB_TUNING) lengths.push(Math.max(1, Math.trunc((t + ch * STEREO_SPREAD) * scale)));
    for (let ch = 0; ch < 2; ch++) for (const t of ALLPASS_TUNING) lengths.push(Math.max(1, Math.trunc((t + ch * STEREO_SPREAD) * scale)));
    const chorusLen = Math.trunc(0.05 * sr) + 4;
    lengths.push(chorusLen, chorusLen);
    const n = lengths.length;
    this.offs = new Int32Array(n); this.lens = new Int32Array(n); this.idx = new Int32Array(n);
    let o = 0;
    for (let i = 0; i < n; i++) { this.offs[i] = o; this.lens[i] = lengths[i]; o += lengths[i]; }
    this.buf = new Float32Array(o);
  }

  /** GBK extension (not in the Swift port): global parameters. Not real-time critical; allocation-free. */
  setParams(p: { roomSize?: number; damping?: number; reverbLevel?: number; chorusLevel?: number; chorusDepthMs?: number; chorusRateHz?: number; chorusDelayMs?: number }): void {
    const c = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
    if (Number.isFinite(p.roomSize)) this.roomFeedback = f(0.7 + 0.28 * c(p.roomSize!, 0, 1));
    if (Number.isFinite(p.damping)) this.damp = f(0.4 * c(p.damping!, 0, 1));
    if (Number.isFinite(p.reverbLevel)) this.reverbWet = f(0.7 * c(p.reverbLevel!, 0, 1));
    if (Number.isFinite(p.chorusLevel)) this.chorusWet = c(p.chorusLevel!, 0, 1);
    if (Number.isFinite(p.chorusRateHz)) this.chorusRateHz = c(p.chorusRateHz!, 0.01, 10);
    // Delay line is 50 ms: keep base + depth inside it.
    if (Number.isFinite(p.chorusDelayMs)) this.chorusBaseSec = c(p.chorusDelayMs!, 1, 30) / 1000;
    if (Number.isFinite(p.chorusDepthMs)) this.chorusDepthSec = c(p.chorusDepthMs!, 0, 10) / 1000;
    if (this.chorusDepthSec > this.chorusBaseSec - 0.0005) this.chorusDepthSec = Math.max(0, this.chorusBaseSec - 0.0005);
  }

  clear(): void { this.buf.fill(0); this.combStore.fill(0); }

  private comb(k: number, x: number): number {
    const p = this.offs[k] + this.idx[k];
    const y = this.buf[p];
    this.combStore[k] = f(f(y * f(1 - this.damp)) + f(this.combStore[k] * this.damp));
    this.buf[p] = f(x + f(this.combStore[k] * this.roomFeedback));
    this.idx[k] += 1; if (this.idx[k] >= this.lens[k]) this.idx[k] = 0;
    return y;
  }

  private allpass(k: number, x: number): number {
    const p = this.offs[k] + this.idx[k];
    const b = this.buf[p];
    this.buf[p] = f(x + f(b * 0.5));
    this.idx[k] += 1; if (this.idx[k] >= this.lens[k]) this.idx[k] = 0;
    return f(b - x);
  }

  private chorusLine(line: number, x: number, ph: number): number {
    const o = this.offs[line], n = this.lens[line];
    this.buf[o + this.idx[line]] = x;
    const d = (this.chorusBaseSec + this.chorusDepthSec * Math.sin(2 * Math.PI * ph)) * this.sr;
    let rp = this.idx[line] - d;
    if (rp < 0) rp += n;
    const i0 = Math.trunc(rp) % n, i1 = (i0 + 1) % n, fr = rp - Math.trunc(rp);
    this.idx[line] += 1; if (this.idx[line] >= n) this.idx[line] = 0;
    const a = this.buf[o + i0], b = this.buf[o + i1];
    return a + (b - a) * fr;
  }

  /** One frame: wet reverb + chorus from the send buses, written to outL / outR. */
  process(revL: number, revR: number, choL: number, choR: number): void {
    const input = f(f((revL + revR) * 0.5) * f(0.03));
    let oL = 0, oR = 0;
    for (let k = 0; k < 8; k++) { oL = f(oL + this.comb(k, input)); oR = f(oR + this.comb(8 + k, input)); }
    for (let k = 0; k < 4; k++) { oL = this.allpass(16 + k, oL); oR = this.allpass(20 + k, oR); }
    let l = f(oL * this.reverbWet), r = f(oR * this.reverbWet);
    this.chorusPhase += this.chorusRateHz / this.sr;
    if (this.chorusPhase >= 1) this.chorusPhase -= 1;
    l += this.chorusLine(24, choL, this.chorusPhase) * this.chorusWet;
    r += this.chorusLine(25, choR, this.chorusPhase + 0.25) * this.chorusWet;
    this.outL = l; this.outR = r;
  }
}
