// One AudioContext for the whole session; one sf2-processor worklet engine per participant (bounded by the room
// limit), each with its own preset/controller/voice state, gain (local mix) and analyser (level meter + tests).
// Events go through the worklet's timed live queue at absolute context frames.
import type { SynthEvent } from "../sf2-renderer.ts";
import { synthEvent } from "../synth-ingress.ts";
import { ClockDomainMap } from "../midi-clock/clock-domain.ts";
import { loadSoundFont, resolveInstrument } from "../audio/soundfont-loader.ts";

export interface JamAudioOut {
  ensure(pid: string): void;
  setInstrument(pid: string, bank: number, program: number): Promise<string>;
  /** perfMs = local performance.now() time to sound; null = as soon as possible (after anything already queued for pid). */
  post(pid: string, perfMs: number | null, e: SynthEvent): void;
  clear(pid: string): void;
  panic(pid?: string): void;
  remove(pid: string): void;
  setGain(pid: string, gain: number): void;
  level(pid: string): number;
  info(): { state: string; sampleRate: number | null; baseLatencyMs: number | null; outputLatencyMs: number | null };
  close(): void;
}

interface Strip { node: AudioWorkletNode; gain: GainNode; analyser: AnalyserNode; lastFrame: number; buf: Float32Array<ArrayBuffer> }
export const MAX_ENGINES = 5; // 4 players + the metronome

export class WebJamAudio implements JamAudioOut {
  private ctx!: AudioContext; private url = ""; private strips = new Map<string, Strip>(); private map = new ClockDomainMap(15);
  private timer: ReturnType<typeof setInterval> | null = null; private ready: Promise<void> | null = null;
  private pendingPreset = new Map<string, { bank: number; program: number }>();
  /** Must be called from a user gesture (autoplay policy). */
  start(): Promise<void> {
    if (this.ready) { void this.ctx.resume(); return this.ready; }
    this.ready = (async () => {
      // @ts-ignore Vite worker-url import, same as live-sink.ts
      const { default: url } = (await import("../sf2-processor.ts?worker&url")) as { default: string };
      this.url = url;
      this.ctx = new AudioContext({ latencyHint: "interactive" });
      await this.ctx.audioWorklet.addModule(url);
      if (this.ctx.state !== "running") await this.ctx.resume().catch(() => undefined);
      this.sampleClock(); this.timer = setInterval(() => this.sampleClock(), 250);
      await loadSoundFont();
    })();
    return this.ready;
  }
  private sampleClock() {
    const ts = (this.ctx as AudioContext & { getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number } }).getOutputTimestamp?.();
    if (ts && ts.contextTime && ts.performanceTime) this.map.update(ts.contextTime, ts.performanceTime);
    else this.map.update(this.ctx.currentTime, performance.now() - (this.ctx.baseLatency ?? 0) * 1000); // estimated fallback
  }
  private frameAt(perfMs: number) { return Math.round(this.map.perfToAudio(perfMs) * this.ctx.sampleRate); }
  private nowFrame() { return Math.ceil(this.ctx.currentTime * this.ctx.sampleRate); }
  ensure(pid: string) {
    if (!this.ctx || this.strips.has(pid)) return;
    if (this.strips.size >= MAX_ENGINES) throw new Error("too many engines");
    const node = new AudioWorkletNode(this.ctx, "sf2-processor", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const gain = this.ctx.createGain(); const analyser = this.ctx.createAnalyser(); analyser.fftSize = 512;
    node.connect(gain); gain.connect(this.ctx.destination); gain.connect(analyser);
    this.strips.set(pid, { node, gain, analyser, lastFrame: 0, buf: new Float32Array(analyser.fftSize) });
    const p = this.pendingPreset.get(pid); if (p) void this.setInstrument(pid, p.bank, p.program);
  }
  async setInstrument(pid: string, bank: number, program: number): Promise<string> {
    if (!this.ctx) { this.pendingPreset.set(pid, { bank, program }); return ""; }
    const sf = await loadSoundFont(); this.ensure(pid); const s = this.strips.get(pid)!;
    const r = resolveInstrument(sf.sf, program, bank, bank === 128 ? 9 : 0);
    // Existing voices keep sounding with their old regions; new notes use the new preset (same rule on every client).
    s.node.port.postMessage(synthEvent.setPreset(r.regions, 0));
    this.pendingPreset.set(pid, { bank, program });
    return r.presetName + (r.substituted ? " (substitute)" : "");
  }
  post(pid: string, perfMs: number | null, e: SynthEvent) {
    const s = this.strips.get(pid); if (!s) return;
    const now = this.nowFrame();
    const frame = perfMs === null ? Math.max(s.lastFrame, now) : Math.max(this.frameAt(perfMs), now, s.lastFrame);
    s.lastFrame = frame;
    s.node.port.postMessage({ type: "liveEvent", frame, event: e });
  }
  clear(pid: string) { const s = this.strips.get(pid); if (s) { s.node.port.postMessage({ type: "liveClear" }); s.lastFrame = 0; } }
  panic(pid?: string) { for (const [id, s] of this.strips) if (!pid || id === pid) { s.node.port.postMessage({ type: "livePanic" }); s.lastFrame = 0; } }
  remove(pid: string) { const s = this.strips.get(pid); if (!s) return; s.node.port.postMessage({ type: "livePanic" }); s.node.disconnect(); s.gain.disconnect(); this.strips.delete(pid); }
  setGain(pid: string, g: number) { const s = this.strips.get(pid); if (s) s.gain.gain.setTargetAtTime(Math.max(0, Math.min(2, g)), this.ctx.currentTime, 0.01); }
  level(pid: string) { const s = this.strips.get(pid); if (!s) return 0; s.analyser.getFloatTimeDomainData(s.buf); let m = 0; for (const v of s.buf) m = Math.max(m, Math.abs(v)); return m; }
  info() { return this.ctx ? { state: this.ctx.state, sampleRate: this.ctx.sampleRate, baseLatencyMs: (this.ctx.baseLatency ?? NaN) * 1000, outputLatencyMs: ((this.ctx as AudioContext & { outputLatency?: number }).outputLatency ?? NaN) * 1000 } : { state: "off", sampleRate: null, baseLatencyMs: null, outputLatencyMs: null }; }
  close() { if (this.timer) clearInterval(this.timer); for (const pid of [...this.strips.keys()]) this.remove(pid); void this.ctx?.close().catch(() => undefined); this.ready = null; }
}
