import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ClickScheduler, LATE_TOLERANCE_S } from "../src/midi-clock/click-scheduler.ts";
import { ClockDomainMap, workerToMainMs } from "../src/midi-clock/clock-domain.ts";

const SR = 48000;
const BLOCK = 128;

/** Drive the scheduler with render quanta, updating the schedule ~20 Hz like the main thread does. */
function render(sched: ClickScheduler, fromBlock: number, toBlock: number, beatPeriodS: number, anchorS: number,
  opts: { jitterS?: (n: number) => number; runId?: number } = {}): void {
  const l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);
  for (let b = fromBlock; b < toBlock; b++) {
    const t = (b * BLOCK) / SR;
    if (b % 150 === 0) { // ~20 Hz schedule refresh, each with a slightly different anchor (domain-map noise)
      const noise = opts.jitterS ? opts.jitterS(b) : 0;
      const anchorBeat = Math.max(0, Math.floor((t - anchorS) / beatPeriodS));
      sched.setSchedule(true, opts.runId ?? 1, 0, anchorBeat, anchorS + anchorBeat * beatPeriodS + noise, beatPeriodS);
    }
    l.fill(0); r.fill(0);
    sched.process(t, l, r);
  }
}

test("scheduler: 2 minutes at 120 BPM fires every beat exactly once, 500 ms apart", () => {
  const sched = new ClickScheduler(SR);
  const blocks = Math.ceil((120 * SR) / BLOCK);
  // anchor 0.2 s in the future of the first block; +-0.4 ms schedule noise on every refresh
  let seed = 7;
  const noise = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return ((seed / 4294967296) * 2 - 1) * 0.0004; };
  render(sched, 0, blocks, 0.5, 0.2, { jitterS: noise });
  const log = sched.drainLog();
  const n = log.length / 3;
  assert.equal(n, 240); // beats at 0.2, 0.7, ... 119.7 s
  const beats = Array.from({ length: n }, (_, i) => log[i * 3]);
  beats.forEach((b, i) => assert.equal(b, i));
  assert.equal(new Set(beats).size, n);
  for (let i = 1; i < n; i++) {
    const dt = log[i * 3 + 2] - log[(i - 1) * 3 + 2];
    assert.ok(Math.abs(dt - 0.5) < 0.0015, `interval ${dt}`); // schedule noise + 1-sample quantisation
  }
  assert.equal(sched.skipped, 0);
  assert.equal(sched.totalFired, 240);
});

test("scheduler: re-sending the schedule never repeats a beat; stop halts; a new run restarts at its first beat", () => {
  const sched = new ClickScheduler(SR);
  const l = new Float32Array(BLOCK);
  const blocksPerSec = SR / BLOCK;
  // 8 s of running, schedule re-sent (with the same anchor) on every block
  for (let b = 0; b < 8 * blocksPerSec; b++) {
    sched.setSchedule(true, 1, 0, 0, 0.01, 0.5);
    sched.process(b * BLOCK / SR, l, undefined);
  }
  const first = sched.totalFired;
  assert.equal(first, 16);
  const log1 = sched.drainLog();
  assert.deepEqual(Array.from({ length: 16 }, (_, i) => log1[i * 3]), Array.from({ length: 16 }, (_, i) => i));
  // Stop: nothing more fires, even though the anchor says beats are due
  for (let b = 8 * blocksPerSec; b < 12 * blocksPerSec; b++) {
    sched.setSchedule(false, 1, 0, 0, 0.01, 0.5);
    sched.process(b * BLOCK / SR, l, undefined);
  }
  assert.equal(sched.totalFired, first);
  // Start again (new run id): numbering restarts, first beat fires once, then every 500 ms
  const t0 = 12 * blocksPerSec * BLOCK / SR;
  for (let b = 12 * blocksPerSec; b < 14 * blocksPerSec; b++) {
    sched.setSchedule(true, 2, 0, 0, t0 + 0.01, 0.5);
    sched.process(b * BLOCK / SR, l, undefined);
  }
  const log2 = sched.drainLog();
  assert.deepEqual(Array.from({ length: log2.length / 3 }, (_, i) => log2[i * 3]), [0, 1, 2, 3]);
});

test("scheduler: a click that arrives too late is skipped, a slightly late one still fires", () => {
  const sched = new ClickScheduler(SR);
  const l = new Float32Array(BLOCK);
  sched.setSchedule(true, 1, 0, 0, 1 - 0.05, 0.5); // beat 0 was 50 ms ago relative to the block at t=1
  sched.process(1, l, undefined);
  assert.equal(sched.totalFired, 1);
  const s2 = new ClickScheduler(SR);
  s2.setSchedule(true, 1, 0, 0, 1 - (LATE_TOLERANCE_S + 0.05), 0.5);
  s2.process(1, l, undefined);
  assert.equal(s2.totalFired, 0);
  assert.equal(s2.skipped, 1);
});

test("scheduler: Continue mid-beat waits for firstBeat", () => {
  const sched = new ClickScheduler(SR);
  const l = new Float32Array(BLOCK);
  // resumed at beat 1.25: boundary 1 is in the past, first click should be beat 2
  sched.setSchedule(true, 5, 2, 1, 0.0, 0.5);
  for (let b = 0; b < 400; b++) sched.process(b * BLOCK / SR, l, undefined);
  const log = sched.drainLog();
  assert.equal(log[0], 2);
});

test("scheduler: click audio is produced, sample-accurate within the block", () => {
  const sched = new ClickScheduler(SR);
  const l = new Float32Array(BLOCK);
  const t0 = 10 * BLOCK / SR;
  sched.setSchedule(true, 1, 0, 0, t0 + 40 / SR, 0.5);
  sched.process(t0, l, undefined);
  let first = -1;
  for (let i = 0; i < BLOCK; i++) if (l[i] !== 0 && first < 0) first = i;
  // sin(0) = 0 at the very first sample, so audio starts one sample after the trigger frame
  assert.ok(first >= 40 && first <= 42, `first nonzero sample ${first}`);
  let peak = 0;
  for (let i = 0; i < BLOCK; i++) peak = Math.max(peak, Math.abs(l[i]));
  assert.ok(peak > 0.1 && peak <= 0.5);
});

test("render loop allocation: no per-block heap growth across 200k blocks", () => {
  const sched = new ClickScheduler(SR);
  const l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);
  sched.setSchedule(true, 1, 0, 0, 0.001, 0.5);
  const run = (from: number, to: number) => { for (let b = from; b < to; b++) sched.process(b * BLOCK / SR, l, r); };
  run(0, 20000); // warm up / JIT
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const before = process.memoryUsage().heapUsed;
  run(20000, 220000); // ~9 minutes of audio, ~1070 clicks
  gc?.();
  const grown = process.memoryUsage().heapUsed - before;
  console.log(`# heap growth over 200000 blocks: ${grown} bytes`);
  // 200k blocks of even a 32-byte allocation would be 6.4 MB; allow slack for the test runner itself.
  assert.ok(grown < 1_500_000, `heap grew ${grown} bytes`);
  assert.ok(sched.totalFired > 1000);
});

test("render loop allocation: static audit of process() in the scheduler and the worklet", () => {
  const body = (src: string, sig: RegExp): string => {
    const m = sig.exec(src);
    assert.ok(m, "signature not found");
    let depth = 0, i = src.indexOf("{", m.index + m[0].length - 1);
    const start = i;
    for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; }
    return src.slice(start, i + 1);
  };
  const sched = body(readFileSync(new URL("../src/midi-clock/click-scheduler.ts", import.meta.url), "utf8"), /process\(blockStartS: number[^)]*\): void \{/);
  const proc = body(readFileSync(new URL("../src/midi-clock/click-processor.ts", import.meta.url), "utf8"), /process\(_inputs[^)]*\): boolean \{/);
  const forbidden: [RegExp, string][] = [
    [/\bnew\s/, "new"], [/=>/, "closure"], [/\bfunction\b/, "function"], [/\[[^\]]*,[^\]]*\]\s*[;,)]/, "array literal"],
    [/(^|[^\w\]])\[\s*\]|=\s*\[|\(\s*\[/, "array literal"], [/=\s*\{|\(\s*\{/, "object literal"],
    [/\.(map|filter|slice|concat|push|forEach|reduce|splice)\(/, "allocating array method"], [/`/, "template string"],
    [/\.\.\./, "spread"], [/postMessage/, "postMessage"],
  ];
  for (const [name, text] of [["ClickScheduler.process", sched], ["MidiClickProcessor.process", proc]] as const) {
    for (const [re, what] of forbidden) assert.ok(!re.test(text), `${name} contains ${what}: ${re}`);
  }
  // trigger() is reached from process(); it must be allocation free too
  const src = readFileSync(new URL("../src/midi-clock/click-scheduler.ts", import.meta.url), "utf8");
  const trig = body(src, /private trigger\([^)]*\): void \{/);
  for (const [re, what] of forbidden) assert.ok(!re.test(trig), `trigger() contains ${what}: ${re}`);
});

test("clock domain: workerToMainMs shifts by the difference of time origins", () => {
  assert.equal(workerToMainMs(100, 1_000_050, 1_000_000), 150);
  assert.equal(workerToMainMs(100, 1_000_000, 1_000_050), 50);
});

test("clock domain: map converts perf ms <-> audio s consistently and is robust to outlier samples", () => {
  const map = new ClockDomainMap(15);
  assert.equal(map.ready, false);
  // true relation: audioTime = perfMs/1000 - 5.0
  for (let i = 0; i < 15; i++) {
    const perf = 10_000 + i * 100;
    const noise = i === 4 ? 0.040 : i === 9 ? -0.030 : (i % 3 - 1) * 0.0003; // two bad samples
    map.update(perf / 1000 - 5.0 + noise, perf);
  }
  assert.equal(map.ready, true);
  assert.ok(Math.abs(map.perfToAudio(12_345.6) - (12.3456 - 5.0)) < 0.0005);
  const perf = 20_000.25;
  assert.ok(Math.abs(map.audioToPerf(map.perfToAudio(perf)) - perf) < 1e-6);
  map.reset();
  assert.equal(map.ready, false);
});

test("clock domain: ring keeps only the newest samples (tracks a slow offset change)", () => {
  const map = new ClockDomainMap(5);
  for (let i = 0; i < 5; i++) map.update(i * 0.1, i * 100 + 1000);
  const before = map.perfToAudio(1000);
  for (let i = 5; i < 30; i++) map.update(i * 0.1 - 0.010, i * 100 + 1000); // offset shifted by +10 ms
  const after = map.perfToAudio(1000);
  assert.ok(Math.abs(after - before + 0.010) < 1e-9); // offset +10 ms => audio time of a given perf time is 10 ms earlier
});
