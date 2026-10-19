// Shared constants/types for the MIDI clock follower demo (main thread <-> worker <-> worklet).
// Pure module: no DOM, no Worker, no AudioContext.

/** MIDI System Real-Time status bytes handled by the follower. */
export const MIDI_CLOCK = 0xf8;
export const MIDI_START = 0xfa;
export const MIDI_CONTINUE = 0xfb;
export const MIDI_STOP = 0xfc;
/** Pseudo status code (not a MIDI byte): the input device went away. */
export const INPUT_DISCONNECTED = 0x100;

export const TICKS_PER_BEAT = 24; // MIDI Clock resolution: 24 clocks per quarter note

/**
 * Compact main -> worker event: `[statusCode, timestampMs]`.
 * `timestampMs` is in the *main thread* `performance.now()` domain, which is the domain of
 * Web MIDI `MIDIMessageEvent.timeStamp`. See docs/midi-clock-follower.md ("Clock domains").
 */
export type ClockEventMessage = [code: number, timestampMs: number];

export interface WorkerInitMessage {
  type: "init";
  /** `performance.timeOrigin` of the main thread, so the worker can express "now" in the main domain. */
  mainTimeOrigin: number;
  pollIntervalMs?: number;
  syncTimeoutMs?: number;
}

export type TransportState = "waiting" | "stopped" | "running" | "lost";
export type LostReason = "timeout" | "disconnect" | null;

/** Status snapshot posted worker -> main (about 20 Hz and immediately on every state change). */
export interface ClockStatus {
  type: "status";
  state: TransportState;
  running: boolean;
  /** True while clocks are arriving (sync not lost). */
  synced: boolean;
  lostReason: LostReason;
  bpm: number; // 0 when unknown
  /** Beat phase in [0,1) for the current song position, or -1 when not running. */
  phase: number;
  /** Integer beat number since song start (0-based), -1 when not running. */
  beat: number;
  /** Song position of the most recent clock, in clock ticks (-1 if none). */
  songTick: number;
  /** Increments on every Start/Continue so the click scheduler can reset its "already fired" state. */
  runId: number;
  /** First beat boundary that should click in this run (Continue mid-beat waits for the next boundary). */
  firstBeat: number;
  /** One known beat boundary on the estimated grid: beat number + its time in main `performance.now()` ms. */
  anchorBeat: number;
  anchorMs: number;
  beatPeriodMs: number; // 0 when unknown
  resyncs: number;
  duplicates: number;
  gapTicks: number;
  /** Worker-side main-domain time at which this status was produced. */
  atMs: number;
}

export type WorkerOutMessage = ClockStatus;

/** Main -> click worklet. */
export interface ScheduleMessage {
  type: "schedule";
  running: boolean;
  runId: number;
  firstBeat: number;
  anchorBeat: number;
  /** AudioContext time (seconds) of `anchorBeat`. */
  anchorTimeS: number;
  beatPeriodS: number;
}
export interface FlushRequestMessage {
  type: "flush";
}
export type ClickInMessage = ScheduleMessage | FlushRequestMessage;

/** Worklet -> main: log of fired clicks as flat triplets [beat, scheduledTimeS, renderedTimeS, ...]. */
export interface ClickLogMessage {
  type: "clicks";
  /** Total clicks ever fired by this processor instance. */
  total: number;
  /** Clicks skipped because they were already too late when the schedule arrived. */
  skipped: number;
  /** Render quanta processed. */
  blocks: number;
  /** Flat [beat, scheduledS, renderedS] triplets since the previous flush. */
  log: Float64Array;
}
