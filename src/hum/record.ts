// Microphone capture for humming: getUserMedia -> AudioContext ->
// ScriptProcessor accumulation -> 22,050 Hz mono samples for Basic Pitch.
// (ScriptProcessor is deprecated but universally supported, including the
// headless Chromium used by the smoke test; the graph runs through a zero
// gain so nothing is monitored back into the room.)
import { resampleToBasicPitch } from "./transcribe.ts";

export const MAX_HUM_SECONDS = 60;

export class HumRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private chunks: Float32Array[] = [];
  private captured = 0;

  get recording(): boolean { return this.ctx !== null; }
  /** Seconds captured so far. */
  get elapsed(): number { return this.ctx ? this.captured / this.ctx.sampleRate : 0; }

  async start(): Promise<void> {
    if (this.ctx) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser cannot record from a microphone (getUserMedia unavailable).");
    }
    // Throws NotAllowedError on permission denial; the caller surfaces it.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const ctx = new AudioContext();
    this.ctx = ctx;
    await ctx.resume().catch(() => undefined);
    this.source = ctx.createMediaStreamSource(this.stream);
    this.node = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    this.chunks = [];
    this.captured = 0;
    this.node.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      this.chunks.push(data.slice());
      this.captured += data.length;
    };
    this.source.connect(this.node);
    this.node.connect(mute);
    mute.connect(ctx.destination);
  }

  /** Stop capturing and return the take resampled to 22,050 Hz mono. */
  async stop(): Promise<{ samples: Float32Array; seconds: number }> {
    const ctx = this.ctx;
    if (!ctx) throw new Error("Not recording");
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.node = null; this.source = null; this.stream = null;
    this.ctx = null;
    const rate = ctx.sampleRate;
    const total = this.captured;
    const seconds = total / rate;
    const joined = new Float32Array(total);
    let off = 0;
    for (const c of this.chunks) { joined.set(c, off); off += c.length; }
    this.chunks = [];
    this.captured = 0;
    await ctx.close().catch(() => undefined);
    if (total === 0) return { samples: new Float32Array(0), seconds: 0 };
    const buffer = new AudioBuffer({ length: total, sampleRate: rate, numberOfChannels: 1 });
    buffer.copyToChannel(joined, 0);
    const samples = await resampleToBasicPitch(buffer);
    return { samples, seconds };
  }

  /** Abandon the take without transcribing it. */
  cancel(): void {
    if (!this.ctx) return;
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    const ctx = this.ctx;
    this.node = null; this.source = null; this.stream = null; this.ctx = null;
    this.chunks = []; this.captured = 0;
    void ctx.close().catch(() => undefined);
  }
}
