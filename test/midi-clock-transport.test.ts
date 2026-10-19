import test from "node:test";
import assert from "node:assert/strict";

import { FilteredEstimator } from "../src/midi-clock/clock-estimator.ts";
import { ClockWorkerCore } from "../src/midi-clock/clock-worker-core.ts";
import {
  INPUT_DISCONNECTED, MIDI_CLOCK, MIDI_CONTINUE, MIDI_START, MIDI_STOP, TICKS_PER_BEAT, type ClockStatus,
} from "../src/midi-clock/protocol.ts";
import { createStatusObject, MidiClockTransport, SYNC_LOST_TIMEOUT_MS, WATCHDOG_POLL_MS } from "../src/midi-clock/transport.ts";

const tickMs = (bpm: number) => 60000 / (bpm * TICKS_PER_BEAT);

function newTransport(): MidiClockTransport {
  return new MidiClockTransport(new FilteredEstimator());
}
function status(tr: MidiClockTransport, now: number): ClockStatus {
  return { ...tr.fillStatus(now, createStatusObject()) };
}
/** Feed `count` ideal clocks starting at `t0`; returns the time of the next clock. */
function clocks(tr: MidiClockTransport, t0: number, bpm: number, count: number): number {
  let t = t0;
  for (let i = 0; i < count; i++) { tr.handle(MIDI_CLOCK, t); t += tickMs(bpm); }
  return t;
}

test("start: first clock after Start is tick 0, then beat/phase follow the clock", () => {
  const tr = newTransport();
  assert.equal(tr.state, "waiting");
  let t = clocks(tr, 0, 120, 10); // clocks before Start: synced but stopped
  assert.equal(tr.state, "stopped");
  assert.equal(tr.currentSongTick, -1);

  assert.equal(tr.handle(MIDI_START, t), true);
  assert.equal(tr.state, "running"); // armed, waiting for the first clock
  assert.equal(status(tr, t).running, false);
  const startClockTs = t;
  t = clocks(tr, t, 120, 1);
  assert.equal(tr.currentSongTick, 0);
  const s0 = status(tr, startClockTs);
  assert.equal(s0.running, true);
  assert.equal(s0.beat, 0);
  assert.ok(s0.phase < 0.01);
  assert.equal(s0.firstBeat, 0);
  assert.ok(Math.abs(s0.anchorMs - startClockTs) < 1e-6);

  t = clocks(tr, t, 120, 35); // 36 clocks after Start in total
  const s = status(tr, t - tickMs(120));
  assert.equal(s.songTick, 35);
  assert.equal(s.beat, 1);
  assert.ok(Math.abs(s.phase - 11 / 24) < 0.02, `phase ${s.phase}`);
  assert.ok(Math.abs(s.bpm - 120) < 0.5);
});

test("start restarts the song position; a duplicated Start before the first clock is ignored", () => {
  const tr = newTransport();
  let t = clocks(tr, 0, 120, 5);
  assert.equal(tr.handle(MIDI_START, t), true);
  const run1 = tr.currentRunId;
  assert.equal(tr.handle(MIDI_START, t), false); // same command delivered twice
  assert.equal(tr.currentRunId, run1);
  t = clocks(tr, t, 120, 30);
  assert.equal(tr.currentSongTick, 29);
  tr.handle(MIDI_START, t); // legitimate restart
  assert.equal(tr.currentRunId, run1 + 1);
  clocks(tr, t, 120, 1);
  assert.equal(tr.currentSongTick, 0);
});

test("stop: clocks keep flowing but the song position and beats freeze", () => {
  const tr = newTransport();
  tr.handle(MIDI_START, 0);
  let t = clocks(tr, 0, 120, 30);
  assert.equal(tr.handle(MIDI_STOP, t), true);
  assert.equal(tr.state, "stopped");
  assert.equal(status(tr, t).running, false);
  assert.equal(status(tr, t).beat, -1);
  const before = tr.currentSongTick;
  t = clocks(tr, t, 120, 50);
  assert.equal(tr.currentSongTick, before);
  assert.equal(tr.handle(MIDI_STOP, t), false); // duplicate Stop is a no-op
});

test("continue: resumes from the stopped song position, first click waits for the next beat boundary", () => {
  const tr = newTransport();
  tr.handle(MIDI_START, 0);
  let t = clocks(tr, 0, 120, 30); // song ticks 0..29
  tr.handle(MIDI_STOP, t);
  t = clocks(tr, t, 120, 17); // keeps clocking while stopped
  const run = tr.currentRunId;
  assert.equal(tr.handle(MIDI_CONTINUE, t), true);
  assert.equal(tr.currentRunId, run + 1);
  const continueClockTs = t;
  t = clocks(tr, t, 120, 1);
  assert.equal(tr.currentSongTick, 30); // next tick after the stopped position, not 0
  const s = status(tr, continueClockTs);
  assert.equal(s.beat, 1);
  assert.equal(s.firstBeat, 2); // ceil(30 / 24)
  assert.equal(tr.handle(MIDI_CONTINUE, t), false); // already running
  t = clocks(tr, t, 120, 18);
  assert.equal(tr.currentSongTick, 48);
  assert.equal(status(tr, t - tickMs(120) + 1).beat, 2);
});

test("continue from a beat boundary clicks that boundary; Continue without a prior Start begins at 0", () => {
  const tr = newTransport();
  tr.handle(MIDI_START, 0);
  let t = clocks(tr, 0, 120, 24); // ticks 0..23, next is 24
  tr.handle(MIDI_STOP, t);
  tr.handle(MIDI_CONTINUE, t);
  t = clocks(tr, t, 120, 1);
  assert.equal(tr.currentSongTick, 24);
  assert.equal(status(tr, t).firstBeat, 1);

  const fresh = newTransport();
  clocks(fresh, 0, 120, 3);
  fresh.handle(MIDI_CONTINUE, 100);
  clocks(fresh, 100, 120, 1);
  assert.equal(fresh.currentSongTick, 0);
});

test("missing clocks are inferred from the gap: song position stays correct", () => {
  const tr = newTransport();
  tr.handle(MIDI_START, 0);
  let t = clocks(tr, 0, 120, 30);
  t += 3 * tickMs(120); // three clocks never arrive
  clocks(tr, t, 120, 1);
  assert.equal(tr.currentSongTick, 33);
  assert.equal(tr.estimator.gapTicks, 3);
});

test("duplicated clocks neither advance the song position nor count as a state change", () => {
  const tr = newTransport();
  tr.handle(MIDI_START, 0);
  let t = clocks(tr, 0, 120, 30);
  const tick = tr.currentSongTick;
  const lastTs = t - tickMs(120);
  assert.equal(tr.handle(MIDI_CLOCK, lastTs), false); // same timestamp delivered again
  assert.equal(tr.handle(MIDI_CLOCK, lastTs + 0.01), false);
  assert.equal(tr.currentSongTick, tick);
  assert.equal(tr.estimator.duplicateCount, 2);
  clocks(tr, t, 120, 1);
  assert.equal(tr.currentSongTick, tick + 1);
});

test("120 -> 90 BPM change: resyncs and converges within 1.5 s", () => {
  const tr = newTransport();
  tr.handle(MIDI_START, 0);
  let t = clocks(tr, 0, 120, 24 * 8); // 4 s at 120
  assert.ok(Math.abs(status(tr, t).bpm - 120) < 0.5);
  const changeAt = t;
  const p90 = tickMs(90);
  let convergedAt: number | null = null;
  for (let i = 0; i < 24 * 8; i++) {
    tr.handle(MIDI_CLOCK, t);
    const s = status(tr, t);
    if (convergedAt === null && Math.abs(s.bpm - 90) < 1) convergedAt = t - changeAt;
    t += p90;
  }
  assert.notEqual(convergedAt, null);
  assert.ok(convergedAt! < 1500, `converged after ${convergedAt} ms`);
  assert.ok(tr.estimator.resyncCount >= 1);
  const s = status(tr, t - p90);
  assert.ok(Math.abs(s.bpm - 90) < 0.5, `bpm ${s.bpm}`);
  // song position kept counting through the tempo change (no ticks lost)
  assert.equal(tr.currentSongTick, 24 * 16 - 1);
});

test("device disconnection: lost immediately, transport halts, reconnect restores sync but not the run", () => {
  const tr = newTransport();
  tr.handle(MIDI_START, 0);
  let t = clocks(tr, 0, 120, 40);
  const run = tr.currentRunId;
  assert.equal(tr.handle(INPUT_DISCONNECTED, t), true);
  assert.equal(tr.state, "lost");
  assert.equal(tr.lostBecause, "disconnect");
  assert.equal(status(tr, t).running, false);
  assert.equal(tr.handle(INPUT_DISCONNECTED, t), false); // repeated notification: no new event
  assert.equal(tr.poll(t + 5000), false); // watchdog does not re-report an already lost sync

  t += 3000;
  clocks(tr, t, 120, 5);
  assert.equal(tr.state, "stopped");
  assert.equal(tr.synced, true);
  assert.equal(tr.currentRunId, run);
  assert.equal(status(tr, t).running, false); // no clicks until the master sends Start/Continue
  tr.handle(MIDI_CONTINUE, t + 200);
  assert.equal(tr.currentRunId, run + 1);
});

test("silence is declared as sync lost after the timeout", () => {
  const tr = newTransport();
  tr.handle(MIDI_START, 0);
  const next = clocks(tr, 0, 120, 40);
  const last = next - tickMs(120);
  assert.equal(tr.poll(last + SYNC_LOST_TIMEOUT_MS - 1), false);
  assert.equal(tr.poll(last + SYNC_LOST_TIMEOUT_MS + 1), true);
  assert.equal(tr.state, "lost");
  assert.equal(tr.lostBecause, "timeout");
});

test("worker core: clock loss is reported within 500 ms of the last clock (watchdog at 50 ms)", () => {
  let now = 0;
  const timers = new Map<number, { fn: () => void; ms: number; next: number }>();
  let nextHandle = 1;
  const posted: ClockStatus[] = [];
  const core = new ClockWorkerCore({
    post: (s) => posted.push({ ...s }),
    nowMain: () => now,
    setInterval: (fn, ms) => { const h = nextHandle++; timers.set(h, { fn, ms, next: now + ms }); return h; },
    clearInterval: (h) => { timers.delete(h as number); },
  });
  const advance = (to: number) => {
    for (;;) {
      let due: { fn: () => void; next: number; ms: number } | null = null;
      for (const t of timers.values()) if (t.next <= to && (!due || t.next < due.next)) due = t;
      if (!due) break;
      now = due.next; due.next += due.ms; due.fn();
    }
    now = to;
  };

  core.onMessage({ type: "init", mainTimeOrigin: 0 });
  assert.ok(core.hasTimer);
  core.onMessage([MIDI_START, 0]);
  let lastClock = 0;
  for (let i = 0; i < 100; i++) { now = i * tickMs(120); advance(now); core.onMessage([MIDI_CLOCK, now]); lastClock = now; }
  assert.equal(posted[posted.length - 1].state, "running");
  const countBefore = posted.length;

  // silence: only the watchdog runs
  let lostAt: number | null = null;
  for (let t = lastClock; t <= lastClock + 600 && lostAt === null; t += 10) {
    advance(t);
    if (posted.slice(countBefore).some((s) => s.state === "lost")) lostAt = t;
  }
  assert.notEqual(lostAt, null);
  const latency = lostAt! - lastClock;
  assert.ok(latency <= 500, `loss reported after ${latency} ms`);
  assert.ok(latency <= SYNC_LOST_TIMEOUT_MS + WATCHDOG_POLL_MS + 10, `loss reported after ${latency} ms`);
  assert.equal(posted[posted.length - 1].lostReason, "timeout");
  assert.equal(posted[posted.length - 1].running, false);

  core.dispose();
  assert.equal(core.hasTimer, false);
  assert.equal(timers.size, 0);
  const n = posted.length;
  core.onMessage([MIDI_CLOCK, now + 1]);
  advance(now + 1000);
  assert.equal(posted.length, n); // nothing after dispose
});

test("worker core: re-init replaces the watchdog timer instead of stacking another", () => {
  const timers = new Set<number>();
  let h = 0;
  const core = new ClockWorkerCore({
    post: () => undefined, nowMain: () => 0,
    setInterval: () => { timers.add(++h); return h; },
    clearInterval: (x) => { timers.delete(x as number); },
  });
  core.onMessage({ type: "init", mainTimeOrigin: 0 });
  core.onMessage({ type: "init", mainTimeOrigin: 0 });
  assert.equal(timers.size, 1);
  core.dispose();
  assert.equal(timers.size, 0);
});
