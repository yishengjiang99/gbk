// The sf2-processor AudioWorklet's logic, separated from the AudioWorkletGlobalScope so it can be unit-tested and
// reused by the test-only OfflineAudioContext stand-in. The worklet (src/sf2-processor.ts) is a thin wrapper.
import { Sf2SynthEngine, type SynthEvent } from "./sf2-renderer.ts";

export class Sf2ProcessorCore {
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

  process(outL: Float32Array, outR: Float32Array): void {
    const next = this.engine.renderScheduled(outL, outR, this.scheduledEvents, this.scheduledEventIndex, this.renderedSamples);
    this.scheduledEventIndex = next.eventIndex;
    this.renderedSamples = next.renderedSamples;
  }
}
