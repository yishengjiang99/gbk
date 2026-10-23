// ITU-R BS.1770-4 / EBU R128 integrated loudness (K-weighting, 400 ms blocks with 75 % overlap, -70 LUFS absolute
// and -10 LU relative gates) plus a 4x-oversampled true-peak estimate. Streaming, allocation-free per sample,
// deterministic (pure float math), used to pick ONE whole-file gain: never per section, so CC/velocity dynamics
// and section contrasts are preserved exactly.

/** RBJ-style biquad coefficients for the two K-weighting stages at an arbitrary sample rate (same derivation as
 *  libebur128 / pyloudnorm, which reproduce the 48 kHz coefficients in BS.1770 Table 1/2). */
function kWeighting(sr: number) {
  // Stage 1: high shelf (+4 dB, ~1.68 kHz).
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / sr);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const s1 = { b0: (Vh + Vb * K / Q + K * K) / a0, b1: 2 * (K * K - Vh) / a0, b2: (Vh - Vb * K / Q + K * K) / a0, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  // Stage 2: RLB high-pass (~38 Hz).
  f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan(Math.PI * f0 / sr);
  a0 = 1 + K / Q + K * K;
  const s2 = { b0: 1, b1: -2, b2: 1, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [s1, s2];
}

const TP_TAPS = 16, TP_PHASES = 4;
/** Windowed-sinc polyphase kernel for the 3 intermediate phases of 4x oversampling (BS.1770 Annex 2 style). */
function truePeakKernel(): Float64Array[] {
  const out: Float64Array[] = [];
  for (let ph = 1; ph < TP_PHASES; ph++) {
    const h = new Float64Array(TP_TAPS); const frac = ph / TP_PHASES;
    for (let k = 0; k < TP_TAPS; k++) {
      const t = k - (TP_TAPS / 2 - 1) - frac; // sample offset relative to the interpolated point
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const w = 0.5 * (1 + Math.cos(Math.PI * t / (TP_TAPS / 2 + 1))); // Hann
      h[k] = sinc * w;
    }
    out.push(h);
  }
  return out;
}

export interface LoudnessStats { integratedLufs: number; truePeakDbTP: number; samplePeakDbFS: number }

export class LoudnessMeter {
  private readonly stages: ReturnType<typeof kWeighting>;
  private readonly z: Float64Array; // per channel, per stage: z1, z2
  private readonly sub: number[] = []; // mean-square energy (summed over channels) of each 100 ms sub-block
  private acc = 0; private accN = 0;
  private readonly subLen: number;
  private readonly hist: Float64Array[]; private hi = 0;
  private readonly kern = truePeakKernel();
  private tp = 0; private sp = 0;
  constructor(readonly sampleRate: number, readonly channels: 1 | 2) {
    this.stages = kWeighting(sampleRate);
    this.z = new Float64Array(channels * 4);
    this.subLen = Math.round(sampleRate * 0.1);
    this.hist = Array.from({ length: channels }, () => new Float64Array(TP_TAPS));
  }
  /** Feed the signal exactly as it will be encoded (mono = (L+R)/2), pre-gain. */
  push(l: Float32Array, r: Float32Array, n: number) {
    const [a, b] = this.stages; const z = this.z; const C = this.channels;
    for (let i = 0; i < n; i++) {
      let e = 0;
      for (let c = 0; c < C; c++) {
        const x = C === 1 ? (l[i] + r[i]) * 0.5 : (c === 0 ? l[i] : r[i]);
        const ax = Math.abs(x); if (ax > this.sp) this.sp = ax;
        // True peak: interpolate between the previous samples (delay TP_TAPS/2 is irrelevant for a max).
        const h = this.hist[c]; h[this.hi] = x;
        for (const k of this.kern) {
          let s = 0;
          for (let t = 0; t < TP_TAPS; t++) s += k[t] * h[(this.hi + 1 + t) % TP_TAPS];
          const as = Math.abs(s); if (as > this.tp) this.tp = as;
        }
        // K-weighting: two transposed direct-form II biquads.
        const o = c * 4;
        let y = a.b0 * x + z[o]; z[o] = a.b1 * x - a.a1 * y + z[o + 1]; z[o + 1] = a.b2 * x - a.a2 * y;
        const y2 = b.b0 * y + z[o + 2]; z[o + 2] = b.b1 * y - b.a1 * y2 + z[o + 3]; z[o + 3] = b.b2 * y - b.a2 * y2;
        y = y2; e += y * y; // channel weights G = 1 for L/R
      }
      this.hi = (this.hi + 1) % TP_TAPS;
      this.acc += e; this.accN++;
      if (this.accN === this.subLen) { this.sub.push(this.acc / this.subLen); this.acc = 0; this.accN = 0; }
    }
  }
  /** Integrated loudness the signal would measure at after a gain of `gainDb` (the -70 LUFS absolute gate is not
   *  gain-invariant, so a quiet file's measured loudness moves by slightly more or less than the gain). */
  integratedAt(gainDb: number): number { return this.integrated(Math.pow(10, gainDb / 10)); }
  private integrated(powGain: number): number {
    const blocks: number[] = [];
    for (let i = 0; i + 4 <= this.sub.length; i++) blocks.push(powGain * (this.sub[i] + this.sub[i + 1] + this.sub[i + 2] + this.sub[i + 3]) / 4);
    const L = (ms: number) => -0.691 + 10 * Math.log10(ms);
    const abs = blocks.filter((ms) => ms > 0 && L(ms) > -70);
    let integrated = -Infinity;
    if (abs.length) {
      const rel = L(abs.reduce((s, x) => s + x, 0) / abs.length) - 10;
      const gated = abs.filter((ms) => L(ms) > rel);
      if (gated.length) integrated = L(gated.reduce((s, x) => s + x, 0) / gated.length);
    }
    return integrated;
  }
  result(): LoudnessStats {
    const integrated = this.integrated(1);
    const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
    return { integratedLufs: integrated, truePeakDbTP: db(Math.max(this.tp, this.sp)), samplePeakDbFS: db(this.sp) };
  }
}

export type NormalizeMode = "off" | "peak" | "loudness";
export interface LoudnessReport {
  mode: NormalizeMode; targetLufs: number | null; truePeakCeilingDbTP: number;
  inputLufs: number; inputTruePeakDbTP: number; gainDb: number; outputLufs: number; outputTruePeakDbTP: number;
  limitedBy: "loudness" | "truePeak" | "none";
  /** Exact linear gain applied to every sample (the dB fields are rounded for reporting). */
  gainLinear: number;
}
/** Defaults for agent / export renders: -16 LUFS integrated (web/podcast/Apple Music target), true peak <= -1 dBTP. */
export const LOUDNESS_TARGET_LUFS = -16;
export const TRUE_PEAK_CEILING_DBTP = -1;
/** Upper bound for loudness make-up gain (avoids lifting near-silent material by absurd amounts; peak mode is uncapped). */
export const MAX_GAIN_DB = 40;

/** One whole-file gain from measured stats. */
export function chooseGain(mode: NormalizeMode, s: LoudnessStats, targetLufs = LOUDNESS_TARGET_LUFS, ceiling = TRUE_PEAK_CEILING_DBTP, meter?: LoudnessMeter): LoudnessReport {
  let gainDb = 0; let limitedBy: LoudnessReport["limitedBy"] = "none";
  if (mode !== "off" && Number.isFinite(s.truePeakDbTP)) {
    const peakRoom = ceiling - s.truePeakDbTP;
    if (mode === "peak") { gainDb = peakRoom; limitedBy = "truePeak"; }
    else if (Number.isFinite(s.integratedLufs)) {
      let want = targetLufs - s.integratedLufs;
      // Re-gate at the candidate gain until the OUTPUT measures the target (converges in a few steps).
      if (meter) for (let k = 0; k < 8; k++) { const err = targetLufs - meter.integratedAt(want); if (!Number.isFinite(err) || Math.abs(err) < 0.005) break; want += err; }
      if (want <= peakRoom) { gainDb = want; limitedBy = "loudness"; } else { gainDb = peakRoom; limitedBy = "truePeak"; }
    } else { gainDb = peakRoom; limitedBy = "truePeak"; }
    if (mode === "loudness" && gainDb > MAX_GAIN_DB) { gainDb = MAX_GAIN_DB; limitedBy = "none"; }
  }
  const r2 = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
  return {
    mode, targetLufs: mode === "loudness" ? targetLufs : null, truePeakCeilingDbTP: ceiling,
    inputLufs: r2(s.integratedLufs), inputTruePeakDbTP: r2(s.truePeakDbTP), gainDb: r2(gainDb),
    outputLufs: r2(meter && Number.isFinite(s.integratedLufs) ? meter.integratedAt(gainDb) : s.integratedLufs + gainDb), outputTruePeakDbTP: r2(s.truePeakDbTP + gainDb), limitedBy, gainLinear: Math.pow(10, gainDb / 20),
  };
}
