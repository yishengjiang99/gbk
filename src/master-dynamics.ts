export type DynamicsMode = "off" | "gentle" | "epic";

export const DYNAMICS_MODES: { value: DynamicsMode; label: string; description: string }[] = [
  { value: "off", label: "Off", description: "Original dynamics. Loud mixes may clip." },
  { value: "gentle", label: "Gentle orchestra", description: "Light peak control with wide crescendos." },
  { value: "epic", label: "Epic orchestra", description: "Fuller quiet passages, controlled fortes, and room for dramatic attacks." },
];
export const DEFAULT_DYNAMICS_MODE: DynamicsMode = "epic";
export const DYNAMICS_CEILING_DB = -1;
export const DYNAMICS_LOOKAHEAD_SEC = 0.005;

const PRESETS = {
  gentle: { threshold: -18, ratio: 1.5, knee: 12, attack: 0.035, release: 0.55, makeup: 1.5 },
  epic: { threshold: -22, ratio: 2, knee: 12, attack: 0.025, release: 0.45, makeup: 3 },
};
const dbToGain = (db: number): number => 10 ** (db / 20);
const gainToDb = (gain: number): number => 20 * Math.log10(Math.max(1e-12, gain));

export function isDynamicsMode(value: unknown): value is DynamicsMode {
  return value === "off" || value === "gentle" || value === "epic";
}

/** Gain reduction in dB, with a quadratic knee centered on the threshold. */
export function compressionReductionDb(level: number, threshold: number, ratio: number, knee: number): number {
  const over = level - threshold;
  const slope = 1 - 1 / ratio;
  if (over <= -knee / 2) return 0;
  if (over >= knee / 2) return over * slope;
  return slope * (over + knee / 2) ** 2 / (2 * knee);
}

/**
 * One stereo-linked master bus, shared by the AudioWorklet and WAV renderer.
 * RMS detection and a 70 Hz sidechain high-pass keep bass from dominating the
 * musical compressor. The limiter sees the full-band signal, including bass.
 * No allocations occur in process(); state survives arbitrary render blocks.
 */
export class MasterDynamics {
  readonly latencyFrames: number;
  compressionReduction = 0;
  limitingReduction = 0;
  private mode: DynamicsMode;
  private threshold: number;
  private ratio: number;
  private knee: number;
  private attack: number;
  private release: number;
  private makeup: number;
  private wet: number;
  private readonly rmsCoeff: number;
  private readonly hpCoeff: number;
  private readonly smoothCoeff: number;
  private readonly limiterAttack: number;
  private readonly limiterRelease: number;
  private readonly ceiling = dbToGain(DYNAMICS_CEILING_DB);
  private readonly dryL: Float32Array;
  private readonly dryR: Float32Array;
  private readonly wetL: Float32Array;
  private readonly wetR: Float32Array;
  private readonly peakValues: Float64Array;
  private readonly peakFrames: Float64Array;
  private queueHead = 0;
  private queueTail = 0;
  private frame = 0;
  private hpL = 0;
  private hpR = 0;
  private prevL = 0;
  private prevR = 0;
  private energy = 0;
  private reduction = 0;
  private limiterGain = 1;

  constructor(private readonly sampleRate: number, mode: DynamicsMode = DEFAULT_DYNAMICS_MODE) {
    this.mode = mode;
    const preset = PRESETS[mode === "off" ? "epic" : mode];
    this.threshold = preset.threshold;
    this.ratio = preset.ratio;
    this.knee = preset.knee;
    this.attack = preset.attack;
    this.release = preset.release;
    this.makeup = preset.makeup;
    this.wet = mode === "off" ? 0 : 1;
    this.latencyFrames = Math.max(1, Math.round(sampleRate * DYNAMICS_LOOKAHEAD_SEC));
    const size = this.latencyFrames + 1;
    this.dryL = new Float32Array(size);
    this.dryR = new Float32Array(size);
    this.wetL = new Float32Array(size);
    this.wetR = new Float32Array(size);
    this.peakValues = new Float64Array(size + 1);
    this.peakFrames = new Float64Array(size + 1);
    this.rmsCoeff = Math.exp(-1 / (sampleRate * 0.01));
    this.hpCoeff = Math.exp(-2 * Math.PI * 70 / sampleRate);
    this.smoothCoeff = Math.exp(-1 / (sampleRate * 0.02));
    this.limiterAttack = Math.exp(-1 / (sampleRate * 0.0005));
    this.limiterRelease = Math.exp(-1 / (sampleRate * 0.08));
  }

  setMode(mode: DynamicsMode): void {
    this.mode = mode;
  }

  process(inputL: Float32Array, inputR: Float32Array, outputL: Float32Array, outputR: Float32Array): void {
    const preset = PRESETS[this.mode === "off" ? "epic" : this.mode];
    const targetWet = this.mode === "off" ? 0 : 1;
    const size = this.dryL.length;
    const queueSize = this.peakValues.length;
    let maxReduction = 0;
    let maxLimiting = 0;
    for (let i = 0; i < outputL.length; i += 1) {
      const left = Number.isFinite(inputL[i]) ? inputL[i] : 0;
      const right = Number.isFinite(inputR[i]) ? inputR[i] : 0;
      // Smooth preset changes and crossfade against latency-matched dry audio.
      const smooth = 1 - this.smoothCoeff;
      this.threshold += (preset.threshold - this.threshold) * smooth;
      this.ratio += (preset.ratio - this.ratio) * smooth;
      this.knee += (preset.knee - this.knee) * smooth;
      this.attack += (preset.attack - this.attack) * smooth;
      this.release += (preset.release - this.release) * smooth;
      this.makeup += (preset.makeup - this.makeup) * smooth;
      this.wet += (targetWet - this.wet) * smooth;
      if (Math.abs(targetWet - this.wet) < 1e-6) this.wet = targetWet;

      this.hpL = this.hpCoeff * (this.hpL + left - this.prevL);
      this.hpR = this.hpCoeff * (this.hpR + right - this.prevR);
      this.prevL = left;
      this.prevR = right;
      // Use the louder channel so panned instruments do not shift the image.
      const power = Math.max(this.hpL * this.hpL, this.hpR * this.hpR);
      this.energy = this.rmsCoeff * this.energy + (1 - this.rmsCoeff) * power;
      const targetReduction = compressionReductionDb(
        10 * Math.log10(Math.max(1e-12, this.energy)), this.threshold, this.ratio, this.knee
      );
      // Deeper sustained compression recovers more slowly than small reductions.
      const release = 0.15 + (this.release - 0.15) * Math.min(1, this.reduction / 6);
      const coeff = Math.exp(-1 / (this.sampleRate * (targetReduction > this.reduction ? this.attack : release)));
      this.reduction = coeff * this.reduction + (1 - coeff) * targetReduction;
      const gain = dbToGain(this.makeup - this.reduction);
      const write = this.frame % size;
      this.dryL[write] = left;
      this.dryR[write] = right;
      this.wetL[write] = left * gain;
      this.wetR[write] = right * gain;

      // Monotonic queue: the maximum of the delayed sample and its lookahead.
      // The limiter applies one gain to both channels, preserving stereo balance.
      while (this.queueHead !== this.queueTail && this.peakFrames[this.queueHead] < this.frame - this.latencyFrames) {
        this.queueHead = (this.queueHead + 1) % queueSize;
      }
      const peak = Math.max(Math.abs(this.wetL[write]), Math.abs(this.wetR[write]));
      while (this.queueHead !== this.queueTail) {
        const previous = (this.queueTail + queueSize - 1) % queueSize;
        if (this.peakValues[previous] > peak) break;
        this.queueTail = previous;
      }
      this.peakValues[this.queueTail] = peak;
      this.peakFrames[this.queueTail] = this.frame;
      this.queueTail = (this.queueTail + 1) % queueSize;
      const aheadPeak = this.peakValues[this.queueHead];
      const targetGain = Math.min(1, this.ceiling / Math.max(1e-12, aheadPeak));
      const limiterCoeff = targetGain < this.limiterGain ? this.limiterAttack : this.limiterRelease;
      this.limiterGain = targetGain + limiterCoeff * (this.limiterGain - targetGain);
      const read = (write + 1) % size;
      const delayedPeak = Math.max(Math.abs(this.wetL[read]), Math.abs(this.wetR[read]));
      // Catch the tiny remainder of the attack envelope at an abrupt transient.
      this.limiterGain = Math.min(this.limiterGain, this.ceiling / Math.max(1e-12, delayedPeak));
      outputL[i] = this.dryL[read] * (1 - this.wet) + this.wetL[read] * this.limiterGain * this.wet;
      outputR[i] = this.dryR[read] * (1 - this.wet) + this.wetR[read] * this.limiterGain * this.wet;
      maxReduction = Math.max(maxReduction, this.reduction * this.wet);
      maxLimiting = Math.max(maxLimiting, -gainToDb(this.limiterGain) * this.wet);
      this.frame += 1;
    }
    this.compressionReduction = maxReduction;
    this.limitingReduction = maxLimiting;
  }
}

/** Process in place, retain state across chunks, and remove the worklet latency. */
export async function applyMasterDynamicsToBuffer(
  buffer: AudioBuffer,
  mode: DynamicsMode,
  onProgress?: (progress: number) => void,
): Promise<AudioBuffer> {
  if (mode === "off") {
    onProgress?.(1);
    return buffer;
  }
  const dynamics = new MasterDynamics(buffer.sampleRate, mode);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(Math.min(1, buffer.numberOfChannels - 1));
  const chunkSize = 8192;
  const blockL = new Float32Array(chunkSize);
  const blockR = new Float32Array(chunkSize);
  const total = buffer.length + dynamics.latencyFrames;
  for (let start = 0; start < total; start += chunkSize) {
    const count = Math.min(chunkSize, total - start);
    blockL.fill(0);
    blockR.fill(0);
    blockL.set(left.subarray(start, Math.min(buffer.length, start + count)));
    blockR.set(right.subarray(start, Math.min(buffer.length, start + count)));
    const outL = blockL.subarray(0, count);
    const outR = blockR.subarray(0, count);
    dynamics.process(outL, outR, outL, outR);
    const skip = Math.max(0, dynamics.latencyFrames - start);
    const destination = Math.max(0, start - dynamics.latencyFrames);
    left.set(outL.subarray(skip), destination);
    right.set(outR.subarray(skip), destination);
    onProgress?.((start + count) / total);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return buffer;
}
