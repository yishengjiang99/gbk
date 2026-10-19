// Synthetic MIDI Clock source used when no MIDI device is available. Emits F8 clocks at a configurable tempo
// plus Start/Continue/Stop, stamped with the (ideal + jitter) time in the performance.now() domain, exactly
// like a hardware input would. The timer is injected so tests can drive it deterministically.

import { MIDI_CLOCK, MIDI_CONTINUE, MIDI_START, MIDI_STOP, TICKS_PER_BEAT } from "./protocol.ts";
import { mulberry32 } from "./trace.ts";

export interface SyntheticSourceDeps {
  now(): number;
  emit(code: number, tsMs: number): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export class SyntheticMidiSource {
  private handle: unknown = null;
  private nextTickMs = 0;
  private periodMs: number;
  private bpmValue: number;
  private rand: () => number;
  jitterMs = 0;
  dropProbability = 0;

  constructor(private readonly deps: SyntheticSourceDeps, bpm = 120, seed = 1) {
    this.bpmValue = bpm;
    this.periodMs = 60000 / (bpm * TICKS_PER_BEAT);
    this.rand = mulberry32(seed);
  }

  get bpm(): number { return this.bpmValue; }
  get running(): boolean { return this.handle !== null; }

  setBpm(bpm: number): void {
    this.bpmValue = bpm;
    this.periodMs = 60000 / (bpm * TICKS_PER_BEAT);
  }

  /** Start emitting clocks (the device "connects"). Idempotent. */
  connect(): void {
    if (this.handle !== null) return;
    this.nextTickMs = this.deps.now();
    this.handle = this.deps.setInterval(() => this.pump(), 5);
  }

  /** Stop emitting anything (the device is unplugged / goes silent). Idempotent. */
  disconnect(): void {
    if (this.handle === null) return;
    this.deps.clearInterval(this.handle);
    this.handle = null;
  }

  sendStart(): void { this.deps.emit(MIDI_START, this.deps.now()); }
  sendContinue(): void { this.deps.emit(MIDI_CONTINUE, this.deps.now()); }
  sendStop(): void { this.deps.emit(MIDI_STOP, this.deps.now()); }

  /** Emit every clock whose ideal time has passed. Public so tests can call it directly. */
  pump(): void {
    const now = this.deps.now();
    while (this.nextTickMs <= now) {
      const ideal = this.nextTickMs;
      this.nextTickMs += this.periodMs;
      const r1 = this.rand(), r2 = this.rand();
      if (r2 < this.dropProbability) continue;
      this.deps.emit(MIDI_CLOCK, ideal + (r1 * 2 - 1) * this.jitterMs);
    }
  }
}
