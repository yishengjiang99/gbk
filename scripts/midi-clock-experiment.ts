// Experiment: raw last-interval MIDI Clock estimation vs rolling-median + phase-correction estimation.
//
//   node --import tsx/esm scripts/midi-clock-experiment.ts          (npm run experiment:midi-clock)
//
// Replays seeded 120 BPM traces (jitter, dropped clocks, periodic delivery delays) through both estimators and
// writes docs/midi-clock-experiment.md + docs/midi-clock-experiment.json. Output is fully deterministic:
// re-running overwrites both files with identical bytes. Nothing here is hand-entered.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FilteredEstimator, LastIntervalEstimator, type ClockEstimator } from "../src/midi-clock/clock-estimator.ts";
import { TICKS_PER_BEAT } from "../src/midi-clock/protocol.ts";
import { generateTrace, type Trace, type TraceOptions } from "../src/midi-clock/trace.ts";

// ---- experiment configuration -------------------------------------------------------------------------------
const SPEC: TraceOptions = {
  seed: 1, bpm: 120, durationMs: 60_000, jitterMs: 3, dropProbability: 0.01, delayEveryTicks: 48, delayMs: 20,
};
const PROBE_STEP_MS = 5;
const EVAL_FROM_MS = 2000; // metrics are computed on [2 s, end] for both estimators
const HOLD_MS = 1000; // settled = all probes within thresholds for this long
const THRESH = { settleMs: 2000, bpmErr: 0.5, phaseErrMs: 5 };
const ROBUSTNESS_SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

// ---- measurement --------------------------------------------------------------------------------------------
interface Metrics {
  estimator: string;
  settlingMs: number | null; // null = never settled
  phaseMedianMs: number;
  phaseP95Ms: number;
  bpmErrMedian: number;
  bpmErrP95: number;
  /** Estimator-internal re-lock count (discarded its window). */
  resyncs: number;
  /** External: transitions from |phase err| <= 5 ms to > 5 ms while evaluating (loss-of-alignment events). */
  excursions: number;
  duplicatesDropped: number;
  gapTicksInferred: number;
  pass: { settle: boolean; bpm: boolean; phase: boolean; all: boolean };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function wrapTicks(x: number): number {
  const w = TICKS_PER_BEAT;
  return ((((x + w / 2) % w) + w) % w) - w / 2; // beat-phase error wraps at one beat
}

function evaluate(est: ClockEstimator, trace: Trace): Metrics {
  const endMs = SPEC.durationMs;
  const probeCount = Math.floor(endMs / PROBE_STEP_MS);
  const phaseErr = new Float64Array(probeCount).fill(Infinity);
  const bpmErr = new Float64Array(probeCount).fill(Infinity);
  let ei = 0;
  for (let p = 0; p < probeCount; p++) {
    const t = p * PROBE_STEP_MS;
    while (ei < trace.events.length && trace.events[ei].ts <= t) est.onClock(trace.events[ei++].ts);
    if (est.periodMs > 0) {
      const truthTicks = (t - trace.startMs) / trace.tickPeriodMs;
      phaseErr[p] = Math.abs(wrapTicks(est.tickPositionAt(t) - truthTicks)) * trace.tickPeriodMs;
      bpmErr[p] = Math.abs(est.bpm - trace.bpm);
    }
  }
  const ok = (p: number) => phaseErr[p] < THRESH.phaseErrMs && bpmErr[p] < THRESH.bpmErr;

  // settling: earliest probe from which every probe in the next HOLD_MS is within both thresholds
  const holdProbes = Math.round(HOLD_MS / PROBE_STEP_MS);
  let settling: number | null = null;
  let runStart = -1;
  for (let p = 0; p < probeCount; p++) {
    if (ok(p)) { if (runStart < 0) runStart = p; if (p - runStart + 1 >= holdProbes) { settling = runStart * PROBE_STEP_MS; break; } }
    else runStart = -1;
  }

  const from = Math.round(EVAL_FROM_MS / PROBE_STEP_MS);
  const pe: number[] = [], be: number[] = [];
  let excursions = 0;
  let prevIn = false;
  for (let p = from; p < probeCount; p++) {
    pe.push(phaseErr[p]); be.push(bpmErr[p]);
    const inTol = phaseErr[p] <= THRESH.phaseErrMs;
    if (prevIn && !inTol) excursions++;
    prevIn = inTol;
  }
  pe.sort((a, b) => a - b); be.sort((a, b) => a - b);
  const phaseP95 = quantile(pe, 0.95), bpmP95 = quantile(be, 0.95);
  const pass = {
    settle: settling !== null && settling <= THRESH.settleMs,
    bpm: bpmP95 < THRESH.bpmErr,
    phase: phaseP95 < THRESH.phaseErrMs,
    all: false,
  };
  pass.all = pass.settle && pass.bpm && pass.phase;
  return {
    estimator: est.name, settlingMs: settling,
    phaseMedianMs: quantile(pe, 0.5), phaseP95Ms: phaseP95,
    bpmErrMedian: quantile(be, 0.5), bpmErrP95: bpmP95,
    resyncs: est.resyncCount, excursions, duplicatesDropped: est.duplicateCount, gapTicksInferred: est.gapTicks, pass,
  };
}

const makeEstimators = (): ClockEstimator[] => [new LastIntervalEstimator(), new FilteredEstimator()];

function runScenario(opts: TraceOptions): { trace: Trace; results: Metrics[] } {
  const trace = generateTrace(opts);
  return { trace, results: makeEstimators().map((e) => evaluate(e, trace)) };
}

// ---- run ----------------------------------------------------------------------------------------------------
const primary = runScenario(SPEC);
const ablations = [
  { name: "spec trace (jitter + 1% drops + 20 ms delays)", opts: SPEC },
  { name: "jitter only", opts: { ...SPEC, dropProbability: 0, delayEveryTicks: 0 } },
  { name: "jitter + 1% drops", opts: { ...SPEC, delayEveryTicks: 0 } },
  { name: "jitter + 20 ms delays", opts: { ...SPEC, dropProbability: 0 } },
  { name: "no impairments", opts: { ...SPEC, jitterMs: 0, dropProbability: 0, delayEveryTicks: 0 } },
].map((s) => ({ name: s.name, ...runScenario(s.opts) }));

const robustness = ROBUSTNESS_SEEDS.map((seed) => ({ seed, ...runScenario({ ...SPEC, seed }) }));

const selected = primary.results.filter((r) => r.pass.all).sort((a, b) => a.phaseP95Ms - b.phaseP95Ms)[0]?.estimator ?? null;

// ---- report -------------------------------------------------------------------------------------------------
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const yn = (b: boolean) => (b ? "yes" : "NO");
const settleStr = (m: Metrics) => (m.settlingMs === null ? "never" : `${m.settlingMs} ms`);

function metricsTable(rows: Metrics[]): string {
  const head = "| Estimator | Settling | Phase err median (ms) | Phase err p95 (ms) | BPM err median | BPM err p95 | Resyncs (internal) | Phase excursions >5 ms | Dups dropped | Gap ticks inferred |\n|---|---|---|---|---|---|---|---|---|---|\n";
  return head + rows.map((m) =>
    `| ${m.estimator} | ${settleStr(m)} | ${f(m.phaseMedianMs)} | ${f(m.phaseP95Ms)} | ${f(m.bpmErrMedian, 3)} | ${f(m.bpmErrP95, 3)} | ${m.resyncs} | ${m.excursions} | ${m.duplicatesDropped} | ${m.gapTicksInferred} |`).join("\n");
}

const robustSummary = ["last-interval", "median+phase"].map((name) => {
  const rows = robustness.map((r) => r.results.find((m) => m.estimator === name)!);
  const passes = rows.filter((m) => m.pass.all).length;
  const settled = rows.filter((m) => m.settlingMs !== null).map((m) => m.settlingMs as number);
  const worstPhase = Math.max(...rows.map((m) => m.phaseP95Ms));
  const worstBpm = Math.max(...rows.map((m) => m.bpmErrP95));
  const worstSettle = settled.length === rows.length ? `${Math.max(...settled)} ms` : `never (${rows.length - settled.length} seeds)`;
  return `| ${name} | ${passes}/${rows.length} | ${worstSettle} | ${f(worstPhase)} | ${f(worstBpm, 3)} |`;
}).join("\n");

const t = primary.trace;
const md = `# MIDI Clock estimation: raw last-interval vs rolling-median + phase correction

_Generated by \`scripts/midi-clock-experiment.ts\` (\`npm run experiment:midi-clock\`). Do not edit by hand: re-run the script.
Every number below is measured by that script from seeded, deterministic traces._

## Hypothesis

A filtered estimator (rolling-median period + rolling-median phase correction) on a 120 BPM MIDI Clock trace with
+-3 ms timestamp jitter, 1% missing clock messages and periodic 20 ms delivery delays will:

1. settle within **${THRESH.settleMs / 1000} s**,
2. have BPM error below **${THRESH.bpmErr}**,
3. have p95 beat-phase error below **${THRESH.phaseErrMs} ms**.

## Method

- Trace (seed ${SPEC.seed}, \`src/midi-clock/trace.ts\`): ${SPEC.bpm} BPM = ${f(t.tickPeriodMs, 4)} ms per clock tick (24 per quarter note),
  ${SPEC.durationMs / 1000} s long, ${t.events.length} delivered messages of ${Math.floor(SPEC.durationMs / t.tickPeriodMs)} sent.
  - Jitter: each timestamp gets a uniform offset in [-${SPEC.jitterMs}, +${SPEC.jitterMs}] ms.
  - Missing clocks: each message (except the first) is dropped with probability ${SPEC.dropProbability} (${t.dropped} dropped in this trace).
  - Delivery delays: every ${SPEC.delayEveryTicks}th message (once per second) arrives ${SPEC.delayMs} ms late (${t.delayed} in this trace).
    Delivery is FIFO, so a late message cannot be overtaken; the next message arrives right behind it (minimum spacing 0.1 ms).
- The estimator only sees arrival timestamps, in arrival order. Truth is the ideal tick grid (tick 0 = first message, t = 0).
- Probes every ${PROBE_STEP_MS} ms: at each probe the estimator is asked for its current tick position and BPM using only messages that have already arrived.
  Beat-phase error = |estimated tick position - true tick position| wrapped to one beat, converted to ms. BPM error = |estimated - ${SPEC.bpm}|.
- **Settling time**: earliest time from which every probe stays within BPM error < ${THRESH.bpmErr} and phase error < ${THRESH.phaseErrMs} ms for ${HOLD_MS} ms.
- Median / p95 phase and BPM error: all probes in [${EVAL_FROM_MS / 1000} s, ${SPEC.durationMs / 1000} s] (same window for both estimators). The BPM criterion is applied to the **p95** BPM error (stricter than the median).
  Before an estimator has any BPM its error counts as infinite.
- **Resynchronizations (internal)**: how many times the estimator discarded its window and re-locked. The baseline keeps no state, so this is 0 by construction.
  **Phase excursions (external)**: transitions from |phase error| <= ${THRESH.phaseErrMs} ms to > ${THRESH.phaseErrMs} ms in the evaluation window, counted by the harness for both.
- Estimators:
  - \`last-interval\`: BPM = 60000 / (24 * last inter-message interval); phase from message count and time since the last message. No jitter filtering, no gap/duplicate handling.
  - \`median+phase\` (\`FilteredEstimator\`, defaults unchanged from first commit): tick index += round(dt / period) (so dropped clocks are gaps and a clumped late message is a duplicate);
    period = median of the last 48 beat-length spans; phase = median of the last 48 grid offsets; resync after 2 consecutive ticks > 8 ms off the grid.

## Result (seed ${SPEC.seed}, spec trace)

${metricsTable(primary.results)}

Thresholds: settling <= ${THRESH.settleMs} ms, BPM err p95 < ${THRESH.bpmErr}, phase err p95 < ${THRESH.phaseErrMs} ms.

| Estimator | Settles <= 2 s | BPM err p95 < 0.5 | Phase err p95 < 5 ms | All three |
|---|---|---|---|---|
${primary.results.map((m) => `| ${m.estimator} | ${yn(m.pass.settle)} | ${yn(m.pass.bpm)} | ${yn(m.pass.phase)} | ${yn(m.pass.all)} |`).join("\n")}

**Selected estimator: ${selected ? `\`${selected}\`` : "none (no estimator met all three thresholds)"}.**

## Ablation: which impairment hurts which estimator (seed ${SPEC.seed})

${ablations.map((a) => `### ${a.name}\n\n${metricsTable(a.results)}`).join("\n\n")}

## Robustness across seeds ${ROBUSTNESS_SEEDS[0]}..${ROBUSTNESS_SEEDS[ROBUSTNESS_SEEDS.length - 1]} (spec trace parameters)

| Estimator | Seeds meeting all three | Worst settling | Worst phase err p95 (ms) | Worst BPM err p95 |
|---|---|---|---|---|
${robustSummary}

## Caveats

- Traces are synthetic. Real clocks drift slowly and real jitter is not uniform; the delay model (one late message per second, FIFO) is one reasonable reading of "periodic 20 ms delivery delays".
- The filtered estimator's parameters were fixed before the first measurement and not tuned against these traces; the multi-seed table shows seed sensitivity.
- Tempo changes are not part of this experiment (they are covered by \`test/midi-clock-transport.test.ts\`, 120 -> 90 BPM).
- The first message is never dropped, because the tick numbering of a trace needs a reference tick (in the demo, Start defines tick 0).

## Re-run

\`\`\`
npm run experiment:midi-clock
\`\`\`
`;

const here = dirname(fileURLToPath(import.meta.url));
const docs = resolve(here, "../docs");
mkdirSync(docs, { recursive: true });
writeFileSync(resolve(docs, "midi-clock-experiment.md"), md);
writeFileSync(resolve(docs, "midi-clock-experiment.json"), JSON.stringify({
  config: { spec: SPEC, probeStepMs: PROBE_STEP_MS, evalFromMs: EVAL_FROM_MS, holdMs: HOLD_MS, thresholds: THRESH },
  primary: { dropped: t.dropped, delayed: t.delayed, delivered: t.events.length, results: primary.results },
  selected,
  ablations: ablations.map((a) => ({ name: a.name, results: a.results })),
  robustness: robustness.map((r) => ({ seed: r.seed, results: r.results })),
}, null, 2) + "\n");
console.log(metricsTable(primary.results));
console.log(`selected: ${selected ?? "none"}`);
