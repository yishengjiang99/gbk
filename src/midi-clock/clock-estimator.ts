// Tempo / beat-phase estimators for MIDI Clock (24 ticks per quarter note).
// Pure, deterministic, DOM-free: reused by the worker, the node tests and the experiment script.
//
// Both estimators assign every accepted clock message a monotonically increasing *tick index*
// and can answer "where is the tick grid right now?" via tickPositionAt()/tickTimeMs().

import { TICKS_PER_BEAT } from "./protocol.ts";

export interface ClockEstimator {
  readonly name: string;
  /** Enough ticks seen to trust bpm/phase. */
  readonly locked: boolean;
  /** 0 until known. */
  readonly bpm: number;
  /** Milliseconds per clock tick, 0 until known. */
  readonly periodMs: number;
  /** Tick index of the last accepted clock, -1 if none. */
  readonly tickIndex: number;
  /** Times the estimator discarded its lock and re-synchronised (tempo jump / phase jump). */
  readonly resyncCount: number;
  readonly duplicateCount: number;
  /** Clock ticks inferred missing from index gaps. */
  readonly gapTicks: number;
  reset(): void;
  /** Feed one clock message timestamp (ms). Returns false when it was treated as a duplicate. */
  onClock(tsMs: number): boolean;
  /** Estimated (fractional) tick position at time `tsMs`, on the same scale as `tickIndex`. */
  tickPositionAt(tsMs: number): number;
  /** Estimated time (ms) at which tick `index` occurs/occurred. */
  tickTimeMs(index: number): number;
}

export function bpmFromPeriodMs(periodMs: number): number {
  return periodMs > 0 ? 60000 / (periodMs * TICKS_PER_BEAT) : 0;
}

/** Median of `src[0..n)` using the preallocated `scratch` (no allocation). */
export function medianOf(src: Float64Array, n: number, scratch: Float64Array): number {
  if (n <= 0) return 0;
  for (let i = 0; i < n; i++) {
    const v = src[i];
    let j = i - 1;
    while (j >= 0 && scratch[j] > v) {
      scratch[j + 1] = scratch[j];
      j--;
    }
    scratch[j + 1] = v;
  }
  const mid = n >> 1;
  return n & 1 ? scratch[mid] : 0.5 * (scratch[mid - 1] + scratch[mid]);
}

/** Two timestamps closer than this are the same message delivered twice. */
const DUP_EPS_MS = 0.05;

/**
 * Baseline: BPM from the last inter-message interval; phase from "number of messages received" and the
 * time since the last message. No jitter filtering, no gap or duplicate handling.
 */
export class LastIntervalEstimator implements ClockEstimator {
  readonly name = "last-interval";
  private count = 0;
  private lastTs = 0;
  private dt = 0;
  resyncCount = 0;
  duplicateCount = 0;
  gapTicks = 0;

  get locked(): boolean { return this.count >= 2 && this.dt > 0; }
  get periodMs(): number { return this.dt; }
  get bpm(): number { return bpmFromPeriodMs(this.dt); }
  get tickIndex(): number { return this.count - 1; }

  reset(): void {
    this.count = 0; this.lastTs = 0; this.dt = 0;
    this.resyncCount = 0; this.duplicateCount = 0; this.gapTicks = 0;
  }

  onClock(tsMs: number): boolean {
    if (this.count > 0) {
      const d = tsMs - this.lastTs;
      if (d > 0) this.dt = d;
    }
    this.count++;
    this.lastTs = tsMs;
    return true;
  }

  tickPositionAt(tsMs: number): number {
    if (this.count === 0) return 0;
    return this.dt > 0 ? this.count - 1 + (tsMs - this.lastTs) / this.dt : this.count - 1;
  }

  tickTimeMs(index: number): number {
    return this.lastTs + (index - (this.count - 1)) * this.dt;
  }
}

export interface FilteredEstimatorOptions {
  /** Ticks after which `locked` becomes true. */
  lockTicks?: number;
  /** Ticks used to bootstrap the period before the rolling median takes over. */
  bootTicks?: number;
  /** Span (in ticks) of each period sample; one beat by default. */
  spanTicks?: number;
  /** Smallest span (ticks) allowed to enter the rolling median. */
  minSpanTicks?: number;
  /** Number of span samples in the rolling median. */
  periodWindow?: number;
  /** Number of recent ticks used for the rolling median of grid offsets (phase correction). */
  phaseWindow?: number;
  /** A tick further than this from the predicted grid counts as a phase excursion. */
  resyncThresholdMs?: number;
  /** Consecutive excursions that trigger a resync. */
  resyncConsecutive?: number;
}

const HIST = 128;

/**
 * Rolling-median period + rolling-median phase correction.
 *
 *  - Tick index: idx += round(dt / period) (0 => duplicate / clumped delivery, >1 => missing clocks), so a
 *    late delivery that is ~1 tick behind is simply read as the next tick.
 *  - Period: median of the last `periodWindow` span samples, each (ts[i] - ts[i-24]) / 24. Spanning a full
 *    beat divides endpoint jitter by 24 and the median rejects the occasional bad endpoint.
 *  - Phase: A = median over the last `phaseWindow` ticks of (ts[j] - period * idx[j]); the grid is
 *    T(i) = A + period * i, so single late/early messages cannot move the beat phase.
 *  - Resync: `resyncConsecutive` ticks in a row further than `resyncThresholdMs` from the grid (tempo change
 *    or phase jump) drop the window and re-bootstrap from the most recent ticks.
 *
 * All buffers are preallocated.
 */
export class FilteredEstimator implements ClockEstimator {
  readonly name = "median+phase";
  private readonly lockTicks: number;
  private readonly bootTicks: number;
  private readonly spanTicks: number;
  private readonly minSpanTicks: number;
  private readonly periodWindow: number;
  private readonly phaseWindow: number;
  private readonly resyncThresholdMs: number;
  private readonly resyncConsecutive: number;

  private readonly histIdx = new Float64Array(HIST);
  private readonly histTs = new Float64Array(HIST);
  private histHead = 0; // next write slot
  private histLen = 0;
  private readonly spans: Float64Array;
  private spanHead = 0;
  private spanLen = 0;
  private readonly scratch: Float64Array;
  private readonly offsets: Float64Array;

  private lastIdx = -1;
  private lastTs = 0;
  private period = 0;
  private phaseA = 0;
  private accepted = 0;
  private badStreak = 0;

  resyncCount = 0;
  duplicateCount = 0;
  gapTicks = 0;

  constructor(opts: FilteredEstimatorOptions = {}) {
    this.lockTicks = opts.lockTicks ?? 24;
    this.bootTicks = opts.bootTicks ?? 3;
    this.spanTicks = opts.spanTicks ?? TICKS_PER_BEAT;
    this.minSpanTicks = opts.minSpanTicks ?? 8;
    this.periodWindow = opts.periodWindow ?? 48;
    this.phaseWindow = Math.min(opts.phaseWindow ?? 48, HIST);
    this.resyncThresholdMs = opts.resyncThresholdMs ?? 8;
    this.resyncConsecutive = opts.resyncConsecutive ?? 2;
    this.spans = new Float64Array(this.periodWindow);
    this.scratch = new Float64Array(Math.max(this.periodWindow, this.phaseWindow));
    this.offsets = new Float64Array(this.phaseWindow);
  }

  get locked(): boolean { return this.period > 0 && this.accepted >= this.lockTicks; }
  get periodMs(): number { return this.period; }
  get bpm(): number { return bpmFromPeriodMs(this.period); }
  get tickIndex(): number { return this.lastIdx; }

  reset(): void {
    this.histHead = 0; this.histLen = 0; this.spanHead = 0; this.spanLen = 0;
    this.lastIdx = -1; this.lastTs = 0; this.period = 0; this.phaseA = 0;
    this.accepted = 0; this.badStreak = 0;
    this.resyncCount = 0; this.duplicateCount = 0; this.gapTicks = 0;
  }

  /** Newest entry is back = 0. */
  private histAt(back: number): number {
    return (this.histHead - 1 - back + HIST * 2) % HIST;
  }

  private pushHist(idx: number, ts: number): void {
    this.histIdx[this.histHead] = idx;
    this.histTs[this.histHead] = ts;
    this.histHead = (this.histHead + 1) % HIST;
    if (this.histLen < HIST) this.histLen++;
  }

  onClock(tsMs: number): boolean {
    if (this.lastIdx < 0) {
      this.lastIdx = 0; this.lastTs = tsMs; this.accepted = 1;
      this.pushHist(0, tsMs);
      this.phaseA = tsMs;
      return true;
    }
    const dt = tsMs - this.lastTs;
    let m = 1;
    if (this.period > 0) {
      m = Math.round(dt / this.period);
      if (m < 1 || dt < DUP_EPS_MS) {
        this.duplicateCount++;
        return false;
      }
      if (m > 1000) m = 1000;
    } else if (dt < DUP_EPS_MS) {
      this.duplicateCount++;
      return false;
    }
    const idx = this.lastIdx + m;

    if (this.period > 0 && this.accepted >= this.bootTicks) {
      const resid = tsMs - (this.phaseA + this.period * idx);
      if (resid > this.resyncThresholdMs || resid < -this.resyncThresholdMs) this.badStreak++;
      else this.badStreak = 0;
      if (this.badStreak >= this.resyncConsecutive) {
        this.resync(idx, tsMs);
        if (m > 1) this.gapTicks += m - 1;
        return true;
      }
    }
    if (m > 1) this.gapTicks += m - 1;

    this.lastIdx = idx; this.lastTs = tsMs; this.accepted++;
    this.pushHist(idx, tsMs);
    this.updatePeriod(idx, tsMs);
    this.updatePhase();
    return true;
  }

  private updatePeriod(idx: number, ts: number): void {
    // Find the newest history entry at least `spanTicks` behind; otherwise the oldest available.
    let ref = -1;
    for (let b = 1; b < this.histLen; b++) {
      const h = this.histAt(b);
      ref = h;
      if (idx - this.histIdx[h] >= this.spanTicks) break;
    }
    if (ref < 0) return;
    const k = idx - this.histIdx[ref];
    if (k <= 0) return;
    const s = (ts - this.histTs[ref]) / k;
    if (k >= this.minSpanTicks) {
      this.spans[this.spanHead] = s;
      this.spanHead = (this.spanHead + 1) % this.periodWindow;
      if (this.spanLen < this.periodWindow) this.spanLen++;
      this.period = medianOf(this.spans, this.spanLen, this.scratch);
    } else if (this.accepted >= this.bootTicks) {
      this.period = s; // bootstrap from the (short) span until the median has real samples
    }
  }

  private updatePhase(): void {
    if (this.period <= 0) { this.phaseA = this.lastTs - this.period * this.lastIdx; return; }
    const n = Math.min(this.histLen, this.phaseWindow);
    for (let b = 0; b < n; b++) {
      const h = this.histAt(b);
      this.offsets[b] = this.histTs[h] - this.period * this.histIdx[h];
    }
    this.phaseA = medianOf(this.offsets, n, this.scratch);
  }

  private resync(idx: number, ts: number): void {
    this.resyncCount++;
    this.badStreak = 0;
    // Re-bootstrap from the last good tick (the interval after it is already at the new tempo) plus the
    // tick that triggered the resync. The ticks in between are on the new grid but are dropped from the window.
    const back = Math.min(this.histLen - 1, this.resyncConsecutive - 1);
    const tmpIdx0 = this.histIdx[this.histAt(back)];
    const tmpTs0 = this.histTs[this.histAt(back)];
    this.histHead = 0; this.histLen = 0; this.spanHead = 0; this.spanLen = 0;
    this.pushHist(tmpIdx0, tmpTs0);
    this.pushHist(idx, ts);
    this.lastIdx = idx; this.lastTs = ts; this.accepted = 2;
    const k = idx - tmpIdx0;
    this.period = k > 0 ? (ts - tmpTs0) / k : this.period;
    this.updatePhase();
  }

  tickPositionAt(tsMs: number): number {
    if (this.lastIdx < 0) return 0;
    if (this.period <= 0) return this.lastIdx;
    return (tsMs - this.phaseA) / this.period;
  }

  tickTimeMs(index: number): number {
    if (this.lastIdx < 0) return 0;
    if (this.period <= 0) return this.lastTs;
    return this.phaseA + this.period * index;
  }
}
