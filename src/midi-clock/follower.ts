// Main-thread controller for the MIDI clock follower demo. Framework-free; every browser dependency is injected
// through FollowerDeps so the setup/teardown paths can be tested in Node with fakes.
//
//   Web MIDI input / synthetic source --[code, ts]--> Worker (estimator + transport)
//   Worker --status--> main (convert main-perf ms -> AudioContext s) --schedule--> AudioWorklet click processor

import { ClockDomainMap } from "./clock-domain.ts";
import { MidiInputManager, type MidiAccessLike } from "./midi-input-manager.ts";
import {
  INPUT_DISCONNECTED,
  type ClickInMessage, type ClickLogMessage, type ClockStatus, type ScheduleMessage, type WorkerInitMessage,
} from "./protocol.ts";
import { SyntheticMidiSource } from "./synthetic-source.ts";

export interface PortLike {
  postMessage(data: unknown, transfer?: Transferable[]): void;
  close(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- real Worker/MessagePort types use MessageEvent
  onmessage: ((e: any) => void) | null;
}
export interface WorkerLike {
  postMessage(data: unknown): void;
  terminate(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- real Worker/MessagePort types use MessageEvent
  onmessage: ((e: any) => void) | null;
}
export interface AudioNodeLike {
  port: PortLike;
  connect(dest: unknown): unknown;
  disconnect(): void;
}
export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: unknown;
  readonly state: string;
  resume(): Promise<void>;
  close(): Promise<void>;
  getOutputTimestamp(): { contextTime?: number; performanceTime?: number };
  audioWorklet: { addModule(url: string): Promise<void> };
}

export interface FollowerDeps {
  createWorker(): WorkerLike;
  createAudioContext(): AudioContextLike;
  createClickNode(ctx: AudioContextLike): AudioNodeLike;
  clickProcessorUrl: string;
  now(): number;
  timeOrigin(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  requestMidiAccess?(): Promise<MidiAccessLike>;
  onStatus?(status: ClockStatus): void;
  onClicks?(msg: ClickLogMessage): void;
  onInputsChanged?(inputs: { id: string; name: string }[]): void;
}

const DOMAIN_SAMPLE_MS = 100;
const FLUSH_MS = 250;
const MAX_LOG = 30000; // flat entries (10000 clicks)

export class MidiClockFollower {
  private worker: WorkerLike | null = null;
  private ctx: AudioContextLike | null = null;
  private node: AudioNodeLike | null = null;
  private domainTimer: unknown = null;
  private flushTimer: unknown = null;
  private midi: MidiInputManager | null = null;
  private synthetic: SyntheticMidiSource | null = null;
  private readonly domain = new ClockDomainMap();
  private disposed = false;
  private starting: Promise<void> | null = null;

  lastStatus: ClockStatus | null = null;
  readonly clickLog: number[] = [];
  clickTotal = 0;
  clickSkipped = 0;
  eventsSent = 0;

  constructor(private readonly deps: FollowerDeps) {}

  get audioContext(): AudioContextLike | null { return this.ctx; }
  get inputListenerCount(): number { return this.midi?.listenerCount ?? 0; }
  get isDisposed(): boolean { return this.disposed; }
  get domainMap(): ClockDomainMap { return this.domain; }

  /** Create the worker, the AudioContext and the click AudioWorkletNode. Idempotent. Needs a user gesture in browsers. */
  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("follower disposed"));
    if (!this.starting) this.starting = this.doStart();
    return this.starting;
  }

  private async doStart(): Promise<void> {
    const worker = this.deps.createWorker();
    this.worker = worker;
    worker.onmessage = ({ data }) => this.onWorkerMessage(data as ClockStatus);
    const init: WorkerInitMessage = { type: "init", mainTimeOrigin: this.deps.timeOrigin() };
    worker.postMessage(init);

    const ctx = this.deps.createAudioContext();
    this.ctx = ctx;
    await ctx.resume();
    await ctx.audioWorklet.addModule(this.deps.clickProcessorUrl);
    if (this.disposed) return; // dispose() raced with start(): it already closed ctx/worker
    const node = this.deps.createClickNode(ctx);
    node.port.onmessage = ({ data }) => this.onClickMessage(data as ClickLogMessage);
    node.connect(ctx.destination);
    this.node = node;

    this.sampleDomain();
    this.domainTimer = this.deps.setInterval(() => this.sampleDomain(), DOMAIN_SAMPLE_MS);
    this.flushTimer = this.deps.setInterval(() => this.requestFlush(), FLUSH_MS);
  }

  private sampleDomain(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const ts = ctx.getOutputTimestamp();
    if (ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
      this.domain.update(ts.contextTime, ts.performanceTime);
    }
  }

  private requestFlush(): void {
    const msg: ClickInMessage = { type: "flush" };
    this.node?.port.postMessage(msg);
  }

  private onClickMessage(msg: ClickLogMessage): void {
    if (!msg || msg.type !== "clicks") return;
    this.clickTotal = msg.total;
    this.clickSkipped = msg.skipped;
    for (let i = 0; i < msg.log.length && this.clickLog.length < MAX_LOG; i++) this.clickLog.push(msg.log[i]);
    this.deps.onClicks?.(msg);
  }

  private onWorkerMessage(status: ClockStatus): void {
    if (this.disposed || !status || status.type !== "status") return;
    this.lastStatus = status;
    this.deps.onStatus?.(status);
    if (this.node && this.domain.ready) {
      const msg: ScheduleMessage = {
        type: "schedule",
        running: status.running,
        runId: status.runId,
        firstBeat: status.firstBeat,
        anchorBeat: status.anchorBeat,
        anchorTimeS: this.domain.perfToAudio(status.anchorMs),
        beatPeriodS: status.beatPeriodMs / 1000,
      };
      this.node.port.postMessage(msg);
    }
  }

  /** Forward one clock/transport event (timestamp in main performance.now() domain). */
  feed(code: number, tsMs: number): void {
    if (this.disposed || !this.worker) return;
    this.eventsSent++;
    this.worker.postMessage([code, tsMs]);
  }

  /** Synthetic source (no MIDI hardware needed). Created lazily and owned by the follower. */
  syntheticSource(): SyntheticMidiSource {
    if (!this.synthetic) {
      this.synthetic = new SyntheticMidiSource({
        now: () => this.deps.now(),
        emit: (code, ts) => this.feed(code, ts),
        setInterval: (fn, ms) => this.deps.setInterval(fn, ms),
        clearInterval: (h) => this.deps.clearInterval(h),
      });
    }
    return this.synthetic;
  }

  /** Request Web MIDI access and listen to clock messages from the selected input. */
  async connectMidi(selectedId?: string): Promise<void> {
    if (!this.deps.requestMidiAccess) throw new Error("Web MIDI not available");
    const access = await this.deps.requestMidiAccess();
    if (this.disposed) return;
    if (!this.midi) {
      this.midi = new MidiInputManager({
        onRealtime: (status, ts) => this.feed(status, ts),
        onInputLost: () => this.feed(INPUT_DISCONNECTED, this.deps.now()),
        onInputsChanged: (inputs) => this.deps.onInputsChanged?.(inputs),
        now: () => this.deps.now(),
      });
    }
    this.midi.attach(access);
    if (selectedId) this.midi.select(selectedId);
  }

  selectMidiInput(id: string | null): void { this.midi?.select(id); }

  /** Release every listener, timer, port, worker and the AudioContext. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.synthetic?.disconnect();
    this.synthetic = null;
    this.midi?.dispose();
    this.midi = null;
    if (this.domainTimer !== null) { this.deps.clearInterval(this.domainTimer); this.domainTimer = null; }
    if (this.flushTimer !== null) { this.deps.clearInterval(this.flushTimer); this.flushTimer = null; }
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.postMessage({ type: "dispose" });
      this.worker.terminate();
      this.worker = null;
    }
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.port.close();
      this.node.disconnect();
      this.node = null;
    }
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== "closed") await ctx.close();
  }
}
