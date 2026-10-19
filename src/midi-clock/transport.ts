// MIDI transport state machine: Start / Continue / Stop / Clock handling plus sync-loss detection.
// Pure and deterministic: time only enters through the `tsMs` / `nowMs` arguments.

import {
  INPUT_DISCONNECTED, MIDI_CLOCK, MIDI_CONTINUE, MIDI_START, MIDI_STOP, TICKS_PER_BEAT,
  type ClockStatus, type LostReason, type TransportState,
} from "./protocol.ts";
import type { ClockEstimator } from "./clock-estimator.ts";

/**
 * No clock for this long => sync lost. 250 ms is 12 ticks at 120 BPM and still >3 ticks at 30 BPM;
 * with the worker's 50 ms watchdog poll the loss is reported within 300 ms (+ one postMessage hop),
 * inside the 500 ms requirement.
 */
export const SYNC_LOST_TIMEOUT_MS = 250;
export const WATCHDOG_POLL_MS = 50;

export class MidiClockTransport {
  private readonly est: ClockEstimator;
  private readonly timeoutMs: number;

  private running = false;
  /** Start/Continue received, waiting for the next clock that defines the song position. */
  private pending: "start" | "continue" | null = null;
  /** Song position (ticks) of the next tick to play after a Stop. */
  private pausedPos = 0;
  private basePos = 0;
  private eBase = 0;
  private songTick = -1;
  private firstBeat = 0;
  private runId = 0;

  private sawClock = false;
  private lost = false;
  private lostReason: LostReason = null;
  private lastClockTs = 0;

  constructor(estimator: ClockEstimator, syncTimeoutMs: number = SYNC_LOST_TIMEOUT_MS) {
    this.est = estimator;
    this.timeoutMs = syncTimeoutMs;
  }

  get state(): TransportState {
    if (this.lost) return "lost";
    if (!this.sawClock && !this.running && !this.pending) return "waiting";
    return this.running || this.pending ? "running" : "stopped";
  }
  get isRunning(): boolean { return this.running || this.pending !== null; }
  get synced(): boolean { return this.sawClock && !this.lost; }
  get currentRunId(): number { return this.runId; }
  get currentSongTick(): number { return this.songTick; }
  get lostBecause(): LostReason { return this.lostReason; }
  get estimator(): ClockEstimator { return this.est; }

  /**
   * Handle one event. Returns true when externally visible state changed (state, run id, sync).
   * `code` is a MIDI real-time status byte or INPUT_DISCONNECTED.
   */
  handle(code: number, tsMs: number): boolean {
    switch (code) {
      case MIDI_CLOCK: return this.onClock(tsMs);
      case MIDI_START: return this.onStart(tsMs);
      case MIDI_CONTINUE: return this.onContinue(tsMs);
      case MIDI_STOP: return this.onStop();
      case INPUT_DISCONNECTED: return this.declareLost("disconnect");
      default: return false;
    }
  }

  private onClock(tsMs: number): boolean {
    let changed = false;
    if (this.lost) {
      // Clocks are back: sync is restored but the song position is unknown, so stay stopped until the
      // master sends Start/Continue.
      this.lost = false;
      this.lostReason = null;
      this.est.reset();
      changed = true;
    }
    if (!this.sawClock) { this.sawClock = true; changed = true; }
    this.lastClockTs = tsMs;
    const accepted = this.est.onClock(tsMs);
    if (!accepted) return changed; // duplicated clock: no tick, no beat advance
    const e = this.est.tickIndex;
    if (this.pending) {
      this.eBase = e - this.basePos;
      this.pending = null;
      this.running = true;
      this.firstBeat = Math.ceil(this.basePos / TICKS_PER_BEAT);
      this.songTick = this.basePos;
      return true;
    }
    if (this.running) this.songTick = e - this.eBase;
    return changed;
  }

  private onStart(_tsMs: number): boolean {
    // A repeated Start before any clock has arrived is the same command delivered twice.
    if (this.pending === "start") return false;
    this.pending = "start";
    this.basePos = 0;
    this.pausedPos = 0;
    this.running = false;
    this.songTick = -1;
    this.runId++;
    return true;
  }

  private onContinue(_tsMs: number): boolean {
    if (this.running || this.pending) return false; // already running (or about to): ignore duplicates
    this.pending = "continue";
    this.basePos = this.pausedPos;
    this.runId++;
    return true;
  }

  private onStop(): boolean {
    if (!this.running && !this.pending) return false;
    if (this.running && this.songTick >= 0) this.pausedPos = this.songTick + 1;
    this.running = false;
    this.pending = null;
    return true;
  }

  /** Watchdog: call periodically with `nowMs` in the same domain as the event timestamps. */
  poll(nowMs: number): boolean {
    if (this.sawClock && !this.lost && nowMs - this.lastClockTs > this.timeoutMs) {
      return this.declareLost("timeout");
    }
    return false;
  }

  private declareLost(reason: Exclude<LostReason, null>): boolean {
    if (this.lost || !this.sawClock) {
      // Never had sync (or already lost): remember the pending state but there is nothing to report.
      if (!this.sawClock) { this.running = false; this.pending = null; }
      return false;
    }
    if (this.running && this.songTick >= 0) this.pausedPos = this.songTick + 1;
    this.running = false;
    this.pending = null;
    this.lost = true;
    this.lostReason = reason;
    this.est.reset();
    return true;
  }

  /** Fill `out` (reuse one object per worker) with the current status. */
  fillStatus(nowMs: number, out: ClockStatus): ClockStatus {
    const est = this.est;
    const running = this.running;
    out.type = "status";
    out.state = this.state;
    out.running = running; // clocking; a pending Start/Continue has no song position yet
    out.synced = this.synced;
    out.lostReason = this.lostReason;
    out.bpm = est.bpm;
    out.songTick = this.songTick;
    out.runId = this.runId;
    out.firstBeat = this.firstBeat;
    out.resyncs = est.resyncCount;
    out.duplicates = est.duplicateCount;
    out.gapTicks = est.gapTicks;
    out.atMs = nowMs;
    const periodMs = est.periodMs;
    out.beatPeriodMs = periodMs * TICKS_PER_BEAT;
    if (running && this.songTick >= 0) {
      const pos = (est.tickPositionAt(nowMs) - this.eBase) / TICKS_PER_BEAT;
      const beat = Math.floor(Math.max(pos, 0));
      out.beat = beat;
      out.phase = Math.min(Math.max(pos - beat, 0), 0.999999);
      const anchorBeat = Math.floor(this.songTick / TICKS_PER_BEAT);
      out.anchorBeat = anchorBeat;
      out.anchorMs = est.tickTimeMs(this.eBase + anchorBeat * TICKS_PER_BEAT);
    } else {
      out.beat = -1;
      out.phase = -1;
      out.anchorBeat = 0;
      out.anchorMs = 0;
    }
    return out;
  }
}

export function createStatusObject(): ClockStatus {
  return {
    type: "status", state: "waiting", running: false, synced: false, lostReason: null, bpm: 0,
    phase: -1, beat: -1, songTick: -1, runId: 0, firstBeat: 0, anchorBeat: 0, anchorMs: 0,
    beatPeriodMs: 0, resyncs: 0, duplicates: 0, gapTicks: 0, atMs: 0,
  };
}
