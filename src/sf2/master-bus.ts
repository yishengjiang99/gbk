// Master-bus dynamics, applied after the voice mix and the effect returns.
// Non-normative: SoundFont 2.01 has no master output stage. This module has to match
// sf2player-swift Sources/SF2Engine/MasterBus.swift operation for operation, because the
// cross-engine parity test compares the two.
//
// The stages run in this order:
//   1. masterGain (dB). The engine applies it even when the dynamics are off.
//   2. A stereo-linked feed-forward compressor. It detects peak max(|L|,|R|), uses a
//      soft-knee gain computer in dB, and smooths the gain reduction with one-pole
//      attack and release coefficients, exp(-1 / (t * sr)).
//   3. A brickwall lookahead peak limiter. The ceiling defaults to -0.3 dBFS. The
//      delay line is a preallocated ring buffer. Gain drops instantly to the window
//      minimum and recovers through a one-pole release.
//   4. A safety soft clip: unity below 0.9 * ceiling, then a tanh knee that approaches
//      the ceiling and is bounded by it. Since ceiling < 1, the output is always below 1.0.
// The process() call allocates nothing.

export interface MasterBusParams {
  thresholdDb: number; ratio: number; kneeDb: number; attackMs: number; releaseMs: number;
  ceilingDb: number; limiterReleaseMs: number; lookaheadMs: number;
}
export const MASTER_BUS_DEFAULTS: Readonly<MasterBusParams> = Object.freeze({
  thresholdDb: -6, ratio: 4, kneeDb: 6, attackMs: 5, releaseMs: 100,
  ceilingDb: -0.3, limiterReleaseMs: 50, lookaheadMs: 1.5,
});
export const MASTER_GAIN_DEFAULT_DB = -3;
/** State snap thresholds: these end the exponential tails exactly, and denormals never occur. */
const GR_EPS_DB = 1e-6;
const LIM_EPS = 1e-9;

export class MasterBus {
  outL = 0; outR = 0;
  private p: MasterBusParams = { ...MASTER_BUS_DEFAULTS };
  private aAtt = 0; private aRel = 0; private aLim = 0;
  private ceiling = 1; private clipKnee = 1;
  private grDb = 0;          // compressor gain reduction state (dB, >= 0)
  private limGain = 1;       // limiter gain state (<= 1)
  private la = 0;            // lookahead frames
  private ringL: Float64Array; private ringR: Float64Array; private ringReq: Float64Array;
  private pos = 0; private posReq = 0;
  /** Maximum lookahead (ms) for which the ring is preallocated. */
  static readonly maxLookaheadMs = 10;

  constructor(readonly sampleRate: number, params: Partial<MasterBusParams> = {}) {
    const cap = Math.ceil(MasterBus.maxLookaheadMs * 1e-3 * sampleRate) + 1;
    this.ringL = new Float64Array(cap); this.ringR = new Float64Array(cap); this.ringReq = new Float64Array(cap);
    this.setParams(params);
  }

  get params(): Readonly<MasterBusParams> { return this.p; }
  /** Latency in frames added by the lookahead. */
  get latencyFrames(): number { return this.la; }
  /** Current total dynamic gain reduction in dB (compressor + limiter), for meters and tests. */
  get gainReductionDb(): number { return this.grDb - 20 * Math.log10(this.limGain); }

  /** Compressor gain reduction alone (dB). */
  get compressorReductionDb(): number { return this.grDb; }

  /** Not real-time: call from control code. Resets the state when the lookahead changes. */
  setParams(params: Partial<MasterBusParams>): void {
    const p = { ...this.p, ...params };
    p.ratio = Math.max(1, p.ratio); p.kneeDb = Math.max(0, p.kneeDb);
    p.ceilingDb = Math.min(-0.01, p.ceilingDb);
    p.lookaheadMs = Math.min(MasterBus.maxLookaheadMs, Math.max(0, p.lookaheadMs));
    const sr = this.sampleRate;
    const coef = (ms: number) => (ms > 0 ? Math.exp(-1 / (ms * 1e-3 * sr)) : 0);
    this.aAtt = coef(p.attackMs); this.aRel = coef(p.releaseMs); this.aLim = coef(p.limiterReleaseMs);
    this.ceiling = Math.pow(10, p.ceilingDb / 20); this.clipKnee = 0.9 * this.ceiling;
    const la = Math.round(p.lookaheadMs * 1e-3 * sr);
    const changed = la !== this.la;
    this.p = p; this.la = la;
    if (changed) this.reset();
  }

  reset(): void {
    this.grDb = 0; this.limGain = 1; this.pos = 0; this.posReq = 0; this.outL = 0; this.outR = 0;
    this.ringL.fill(0); this.ringR.fill(0); this.ringReq.fill(1);
  }

  /** Static soft-knee gain computer: gain reduction in dB (>= 0) for an input level in dB. */
  static reductionDb(levelDb: number, thresholdDb: number, ratio: number, kneeDb: number): number {
    const over = levelDb - thresholdDb, slope = 1 - 1 / ratio;
    if (kneeDb > 0 && 2 * over > -kneeDb && 2 * over < kneeDb) { const t = over + kneeDb / 2; return slope * t * t / (2 * kneeDb); }
    return over > 0 ? slope * over : 0;
  }

  /** Safety soft clip toward `ceiling`; |y| <= ceiling < 1, identity below 0.9 * ceiling. */
  static softClip(x: number, ceiling: number): number {
    const k = 0.9 * ceiling, a = x < 0 ? -x : x;
    if (!(a > k)) return a === a ? x : 0;        // NaN maps to 0
    const y = k + (ceiling - k) * Math.tanh((a - k) / (ceiling - k));
    return x < 0 ? -y : y;
  }

  /** One stereo frame in, already scaled by masterGain. The result goes to outL and outR. */
  process(l: number, r: number): void {
    const p = this.p;
    // Non-finite or absurd input is muted so that it cannot poison the state.
    if (!(l <= 1e30 && l >= -1e30)) l = 0;
    if (!(r <= 1e30 && r >= -1e30)) r = 0;
    // 2. compressor
    const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
    const peak = al > ar ? al : ar;
    const target = peak > 1e-10 ? MasterBus.reductionDb(20 * Math.log10(peak), p.thresholdDb, p.ratio, p.kneeDb) : 0;
    const a = target > this.grDb ? this.aAtt : this.aRel;
    this.grDb = target + a * (this.grDb - target);
    if (this.grDb < GR_EPS_DB) this.grDb = 0;
    const cg = Math.pow(10, -this.grDb / 20);
    const cl = l * cg, cr = r * cg;
    // 3. lookahead limiter
    const acl = cl < 0 ? -cl : cl, acr = cr < 0 ? -cr : cr;
    const pk = acl > acr ? acl : acr;
    const req = pk > this.ceiling ? this.ceiling / pk : 1;
    let dl = cl, dr = cr, minReq = req;
    if (this.la > 0) {
      const i = this.pos;
      dl = this.ringL[i]; dr = this.ringR[i];   // written la frames ago
      this.ringL[i] = cl; this.ringR[i] = cr;
      this.pos = i + 1 === this.la ? 0 : i + 1;
      const j = this.posReq;                    // req window: la + 1 frames, delayed output included
      this.ringReq[j] = req;
      this.posReq = j === this.la ? 0 : j + 1;
      for (let k = 0; k <= this.la; k++) { const q = this.ringReq[k]; if (q < minReq) minReq = q; }
    }
    if (minReq < this.limGain) this.limGain = minReq;
    else { this.limGain = minReq + this.aLim * (this.limGain - minReq); if (1 - this.limGain < LIM_EPS) this.limGain = 1; }
    // 4. safety clip
    this.outL = MasterBus.softClip(dl * this.limGain, this.ceiling);
    this.outR = MasterBus.softClip(dr * this.limGain, this.ceiling);
  }
}

/** App volume knob (0...1) -> engine masterGainDb: full volume is the -3 dB default, 0 is -120 dB (silent). */
export function volumeToMasterGainDb(volume: number): number {
  const v = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 1));
  return v <= 0 ? -120 : -3 + 20 * Math.log10(v);
}
