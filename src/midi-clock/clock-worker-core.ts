// Worker-side logic without Worker globals, so tests can drive it with fake timers.

import { FilteredEstimator, type ClockEstimator } from "./clock-estimator.ts";
import type { ClockStatus, WorkerInitMessage } from "./protocol.ts";
import { createStatusObject, MidiClockTransport, SYNC_LOST_TIMEOUT_MS, WATCHDOG_POLL_MS } from "./transport.ts";

export interface ClockWorkerDeps {
  post(status: ClockStatus): void;
  /** Current time expressed in the main thread's performance.now() domain. */
  nowMain(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  createEstimator?(): ClockEstimator;
}

export class ClockWorkerCore {
  private transport: MidiClockTransport;
  private readonly status = createStatusObject(); // reused for every post
  private timer: unknown = null;
  private disposed = false;
  private pollMs = WATCHDOG_POLL_MS;
  private timeoutMs = SYNC_LOST_TIMEOUT_MS;

  constructor(private readonly deps: ClockWorkerDeps) {
    this.transport = this.makeTransport();
  }

  private makeTransport(): MidiClockTransport {
    const est = this.deps.createEstimator ? this.deps.createEstimator() : new FilteredEstimator();
    return new MidiClockTransport(est, this.timeoutMs);
  }

  /** Entry point for every message from the main thread. */
  onMessage(data: unknown): void {
    if (this.disposed) return;
    if (Array.isArray(data)) {
      // compact event: [code, timestampMs]
      if (this.transport.handle(data[0] as number, data[1] as number)) this.post();
      return;
    }
    const msg = data as { type?: string };
    if (msg?.type === "init") this.init(data as WorkerInitMessage);
    else if (msg?.type === "dispose") this.dispose();
  }

  private init(msg: WorkerInitMessage): void {
    if (msg.pollIntervalMs) this.pollMs = msg.pollIntervalMs;
    if (msg.syncTimeoutMs) this.timeoutMs = msg.syncTimeoutMs;
    this.transport = this.makeTransport();
    if (this.timer !== null) this.deps.clearInterval(this.timer);
    this.timer = this.deps.setInterval(() => this.tick(), this.pollMs);
    this.post();
  }

  private tick(): void {
    this.transport.poll(this.deps.nowMain());
    this.post(); // ~20 Hz status for the display + scheduler anchor refresh
  }

  private post(): void {
    this.deps.post(this.transport.fillStatus(this.deps.nowMain(), this.status));
  }

  get hasTimer(): boolean { return this.timer !== null; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) { this.deps.clearInterval(this.timer); this.timer = null; }
  }
}
