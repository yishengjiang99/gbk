// The sf2-processor AudioWorklet's logic, separated from the AudioWorkletGlobalScope so it can be unit-tested and
// reused by the test-only OfflineAudioContext stand-in. The worklet (src/sf2-processor.ts) is a thin wrapper.
import { Sf2SynthEngine, type SynthEvent } from "./sf2-renderer.ts";

/** Live Jam timed queue capacity per engine (events, not voices). */
export const LIVE_QUEUE_CAPACITY = 512;
const isAttack = (e: SynthEvent) => e.type === "noteOn" && ((e as { velocity?: number }).velocity ?? 0) > 0;

export class Sf2ProcessorCore {
  // Timed live queue (Live Jam): absolute context-frame deadlines, sorted, preallocated. Independent of the
  // SMF sequence path; events land at their frame offset inside a render quantum.
  private liveFrames = new Float64Array(LIVE_QUEUE_CAPACITY);
  private liveEvents: (SynthEvent | null)[] = new Array(LIVE_QUEUE_CAPACITY).fill(null);
  private liveHead = 0; private liveLen = 0;
  private liveFrameCounter = 0;
  readonly liveStats = { queued: 0, applied: 0, late: 0, maxLateFrames: 0, droppedAttacks: 0, bypassed: 0, panics: 0 };
  readonly engine: Sf2SynthEngine;
  private scheduledEvents: SynthEvent[] = [];
  private scheduledEventIndex = 0;
  private renderedSamples = 0;
  constructor(sampleRate: number, private reply: (m: Record<string, unknown>) => void = () => {}) { this.engine = new Sf2SynthEngine(sampleRate); }

  onMsg(msg: SynthEvent): void {
    if (msg.type === "setOfflineTracks") {
      this.engine.setTrackStates(msg.tracks ?? []);
      this.engine.setMaxVoices(Math.max(64, msg.maxVoices ?? 64));
      return;
    }
    if (msg.type === "setMasterGainDb") {
      const db = (msg as { db?: number }).db;
      if (typeof db === "number" && Number.isFinite(db)) this.engine.masterGainDb = db;
      return;
    }
    if (msg.type === "setTrackPan") {
      const pan = (msg as { pan?: number }).pan;
      if (typeof pan === "number" && Number.isFinite(pan)) this.engine.trackPan = pan;
      return;
    }
    if (msg.type === "setTrackFader") {
      const gain = (msg as { gain?: number }).gain;
      if (typeof gain === "number" && Number.isFinite(gain)) this.engine.trackFader = gain;
      return;
    }
    if (msg.type === "liveEvent") { const m = msg as unknown as { frame: number; event: SynthEvent }; this.enqueueLive(m.frame, m.event); return; }
    if (msg.type === "liveEvents") { const m = msg as unknown as { items: { frame: number; event: SynthEvent }[] }; for (const it of m.items ?? []) this.enqueueLive(it.frame, it.event); return; }
    if (msg.type === "liveClear") { this.clearLive(); return; }
    if (msg.type === "livePanic") { this.panic(); return; }
    if (msg.type === "liveStats") { this.reply({ type: "liveStats", ...this.liveStats, queued: this.liveLen }); return; }
    if (msg.type === "setSequence") {
      this.scheduledEvents = Array.isArray(msg.events) ? msg.events : [];
      this.scheduledEventIndex = 0;
      this.renderedSamples = 0;
      // Offline renders wait for this ack before startRendering(), so every event is in place before frame 0.
      this.reply({ type: "sequenceReady", events: this.scheduledEvents.length });
      return;
    }
    this.engine.dispatchEvent(msg);
  }

  /** Insert a live event due at absolute context frame `frame`. Full queue: attacks are dropped, everything
   *  else (releases, pedals, controllers) is applied immediately so safety never waits behind a backlog. */
  enqueueLive(frame: number, event: SynthEvent): void {
    if (!event || typeof event.type !== "string" || !Number.isFinite(frame)) return;
    if (this.liveLen >= LIVE_QUEUE_CAPACITY) {
      if (isAttack(event)) { this.liveStats.droppedAttacks++; return; }
      this.liveStats.bypassed++; this.engine.dispatchEvent(event); return;
    }
    // Insertion from the tail keeps it sorted and stable (equal frames keep arrival order).
    let i = this.liveLen;
    while (i > 0) { const j = (this.liveHead + i - 1) % LIVE_QUEUE_CAPACITY; if (this.liveFrames[j] <= frame) break; const k = (j + 1) % LIVE_QUEUE_CAPACITY; this.liveFrames[k] = this.liveFrames[j]; this.liveEvents[k] = this.liveEvents[j]; i--; }
    const at = (this.liveHead + i) % LIVE_QUEUE_CAPACITY; this.liveFrames[at] = frame; this.liveEvents[at] = event; this.liveLen++; this.liveStats.queued++;
  }
  clearLive(): void { for (let i = 0; i < this.liveLen; i++) this.liveEvents[(this.liveHead + i) % LIVE_QUEUE_CAPACITY] = null; this.liveHead = 0; this.liveLen = 0; }
  /** Out-of-band reset: drop queued events, release pedals, kill every voice on every channel. */
  panic(): void {
    this.clearLive(); this.liveStats.panics++;
    for (let ch = 0; ch < 16; ch++) for (const [c, v] of [[64, 0], [66, 0], [123, 0], [120, 0]]) this.engine.dispatchEvent({ type: "controlChange", channel: ch, controller: c, value: v } as SynthEvent);
  }
  get liveQueued(): number { return this.liveLen; }

  /** `currentFrame` = the worklet's absolute context frame at the start of this quantum (omitted offline). */
  process(outL: Float32Array, outR: Float32Array, currentFrame?: number): void {
    const n = Math.min(outL.length, outR.length);
    const base = currentFrame ?? this.liveFrameCounter; this.liveFrameCounter = base + n;
    let i = 0;
    while (this.liveLen > 0 && this.liveFrames[this.liveHead] < base + n) {
      const f = this.liveFrames[this.liveHead]; const off = Math.max(0, Math.floor(f - base));
      if (off > i) { this.renderSeq(outL, outR, i, off); i = off; }
      const ev = this.liveEvents[this.liveHead]!; this.liveEvents[this.liveHead] = null;
      this.liveHead = (this.liveHead + 1) % LIVE_QUEUE_CAPACITY; this.liveLen--;
      if (f < base) { this.liveStats.late++; this.liveStats.maxLateFrames = Math.max(this.liveStats.maxLateFrames, base - f); }
      this.engine.dispatchEvent(ev); this.liveStats.applied++;
    }
    if (i < n) this.renderSeq(outL, outR, i, n);
  }
  private renderSeq(outL: Float32Array, outR: Float32Array, start: number, end: number) {
    const next = this.engine.renderScheduled(outL, outR, this.scheduledEvents, this.scheduledEventIndex, this.renderedSamples, start, end);
    this.scheduledEventIndex = next.eventIndex;
    this.renderedSamples = next.renderedSamples;
  }
}
