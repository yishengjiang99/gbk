// Deterministic synthetic MIDI Clock traces (seeded PRNG). Pure: used by the experiment script and tests.

import { TICKS_PER_BEAT } from "./protocol.ts";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TraceOptions {
  seed: number;
  bpm: number;
  durationMs: number;
  /** Uniform timestamp jitter in [-jitterMs, +jitterMs]. */
  jitterMs: number;
  /** Probability that a clock message is never delivered (the first message is always delivered). */
  dropProbability: number;
  /** Every `delayEveryTicks`-th message is delivered `delayMs` late (FIFO: later messages cannot overtake it). */
  delayEveryTicks: number;
  delayMs: number;
  /** Probability that a delivered clock message is delivered twice (same timestamp). */
  duplicateProbability?: number;
}

export interface TraceEvent {
  /** Delivery (arrival) timestamp in ms; this is what the estimator sees. */
  ts: number;
  /** True tick number of the message (the grid truth). */
  tick: number;
}

export interface Trace {
  events: TraceEvent[];
  bpm: number;
  tickPeriodMs: number;
  /** True time of tick 0 (ms). */
  startMs: number;
  dropped: number;
  delayed: number;
  duplicated: number;
}

export function generateTrace(opts: TraceOptions): Trace {
  const rand = mulberry32(opts.seed);
  const tickPeriodMs = 60000 / (opts.bpm * TICKS_PER_BEAT);
  const count = Math.floor(opts.durationMs / tickPeriodMs);
  const events: TraceEvent[] = [];
  let dropped = 0, delayed = 0, duplicated = 0;
  let prevArrival = -Infinity;
  for (let i = 0; i < count; i++) {
    // Always draw the same number of random values per tick so that changing one probability does not
    // reshuffle the other streams.
    const rJ = rand(), rD = rand(), rU = rand();
    if (i > 0 && rD < opts.dropProbability) { dropped++; continue; }
    let arrival = i * tickPeriodMs + (rJ * 2 - 1) * opts.jitterMs;
    if (opts.delayEveryTicks > 0 && i > 0 && i % opts.delayEveryTicks === 0) { arrival += opts.delayMs; delayed++; }
    if (arrival <= prevArrival) arrival = prevArrival + 0.1; // FIFO delivery with 0.1 ms minimum spacing
    prevArrival = arrival;
    events.push({ ts: arrival, tick: i });
    if (opts.duplicateProbability && rU < opts.duplicateProbability) {
      events.push({ ts: arrival, tick: i });
      duplicated++;
    }
  }
  return { events, bpm: opts.bpm, tickPeriodMs, startMs: 0, dropped, delayed, duplicated };
}
