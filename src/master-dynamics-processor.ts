import { DEFAULT_DYNAMICS_MODE, isDynamicsMode, MasterDynamics } from "./master-dynamics.ts";

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare const sampleRate: number;
declare function registerProcessor(name: string, processor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor): void;

class MasterDynamicsProcessor extends AudioWorkletProcessor {
  private readonly dynamics: MasterDynamics;
  private meterFrames = 0;
  private compressionReduction = 0;
  private limitingReduction = 0;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const mode: unknown = options.processorOptions?.mode;
    this.dynamics = new MasterDynamics(sampleRate, isDynamicsMode(mode) ? mode : DEFAULT_DYNAMICS_MODE);
    this.port.onmessage = ({ data }: MessageEvent) => {
      if (data?.type === "setMode" && isDynamicsMode(data.mode)) this.dynamics.setMode(data.mode);
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const [outL, outR] = outputs[0];
    // Output buffers start at zero, so they also supply silence during tails.
    const inL = inputs[0]?.[0] ?? outL;
    const inR = inputs[0]?.[1] ?? inL;
    this.dynamics.process(inL, inR, outL, outR);
    this.compressionReduction = Math.max(this.compressionReduction, this.dynamics.compressionReduction);
    this.limitingReduction = Math.max(this.limitingReduction, this.dynamics.limitingReduction);
    this.meterFrames += outL.length;
    if (this.meterFrames >= sampleRate / 10) {
      this.port.postMessage({
        type: "meter", compression: this.compressionReduction, limiting: this.limitingReduction,
      });
      this.meterFrames = 0;
      this.compressionReduction = 0;
      this.limitingReduction = 0;
    }
    return true;
  }
}

registerProcessor("master-dynamics", MasterDynamicsProcessor);
