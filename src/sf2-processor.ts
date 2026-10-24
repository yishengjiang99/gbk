import { Sf2ProcessorCore } from "./sf2-processor-core.ts";
import type { SynthEvent } from "./sf2-renderer.ts";

// AudioWorkletProcessor, sampleRate, and registerProcessor are AudioWorkletGlobalScope globals not present in the
// standard Window-scoped DOM lib typings. Declare them here so this module type-checks correctly.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
  constructor();
}
declare const sampleRate: number;
declare function registerProcessor(name: string, processorCtor: new () => AudioWorkletProcessor): void;

/** One SF2 engine per node: realtime playback (AudioContext) and WAV rendering (OfflineAudioContext) alike. */
class Sf2Processor extends AudioWorkletProcessor {
  private core: Sf2ProcessorCore;
  constructor() {
    super();
    this.core = new Sf2ProcessorCore(sampleRate, (m) => this.port.postMessage(m));
    this.port.onmessage = (event: MessageEvent) => this.core.onMsg(event.data as SynthEvent);
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][], _parameters: Record<string, Float32Array>): boolean {
    this.core.process(outputs[0][0], outputs[0][1]);
    return true;
  }
}

registerProcessor("sf2-processor", Sf2Processor);
