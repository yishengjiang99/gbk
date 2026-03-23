import { Sf2SynthEngine, type SynthEvent } from "./sf2-renderer.ts";

// AudioWorkletProcessor, sampleRate, and registerProcessor are
// AudioWorkletGlobalScope globals not present in the standard Window-scoped
// DOM lib typings.  Declare them here so this module type-checks correctly.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
  constructor();
}
declare const sampleRate: number;
declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor
): void;

class Sf2Processor extends AudioWorkletProcessor {
  private engine: Sf2SynthEngine;
  private scheduledEvents: SynthEvent[];
  private scheduledEventIndex: number;
  private renderedSamples: number;

  constructor() {
    super();
    this.engine = new Sf2SynthEngine(sampleRate);
    this.scheduledEvents = [];
    this.scheduledEventIndex = 0;
    this.renderedSamples = 0;
    this.port.onmessage = (event: MessageEvent) => this.onMsg(event.data as SynthEvent);
  }

  private onMsg(msg: SynthEvent): void {
    if (msg.type === "setOfflineTracks") {
      this.engine.setTrackStates(msg.tracks ?? []);
      this.engine.setMaxVoices(Math.max(64, msg.maxVoices ?? 64));
      return;
    }
    if (msg.type === "setSequence") {
      this.scheduledEvents = Array.isArray(msg.events) ? msg.events : [];
      this.scheduledEventIndex = 0;
      this.renderedSamples = 0;
      return;
    }
    this.engine.dispatchEvent(msg);
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ): boolean {
    const outL = outputs[0][0];
    const outR = outputs[0][1];
    const next = this.engine.renderScheduled(
      outL,
      outR,
      this.scheduledEvents,
      this.scheduledEventIndex,
      this.renderedSamples
    );
    this.scheduledEventIndex = next.eventIndex;
    this.renderedSamples = next.renderedSamples;
    return true;
  }
}

registerProcessor("sf2-processor", Sf2Processor);
