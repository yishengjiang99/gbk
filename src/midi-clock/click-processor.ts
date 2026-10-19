// AudioWorkletProcessor: sample-accurate metronome click scheduled against the audio clock.
// Loaded with `audioWorklet.addModule(clickProcessorUrl)` (see follower.ts).

import { ClickScheduler } from "./click-scheduler.ts";
import type { ClickInMessage, ClickLogMessage } from "./protocol.ts";

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(name: string, processor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor): void;

class MidiClickProcessor extends AudioWorkletProcessor {
  private readonly scheduler = new ClickScheduler(sampleRate);

  constructor(_options: AudioWorkletNodeOptions) {
    super();
    this.port.onmessage = ({ data }: MessageEvent<ClickInMessage>) => {
      if (data.type === "schedule") {
        this.scheduler.setSchedule(
          data.running, data.runId, data.firstBeat, data.anchorBeat, data.anchorTimeS, data.beatPeriodS,
        );
      } else if (data.type === "flush") {
        const log = this.scheduler.drainLog();
        const msg: ClickLogMessage = {
          type: "clicks", total: this.scheduler.totalFired, skipped: this.scheduler.skipped,
          blocks: this.scheduler.blocks, log,
        };
        this.port.postMessage(msg, [log.buffer]);
      }
    };
  }

  // Render loop: no allocation (the scheduler preallocates all state; no per-block arrays/objects/closures).
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    this.scheduler.process(currentTime, out[0], out.length > 1 ? out[1] : undefined);
    return true;
  }
}

registerProcessor("midi-click", MidiClickProcessor);
