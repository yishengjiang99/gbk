// Browser LiveSink: a dedicated low-latency SF2 AudioWorklet engine that plays the selected track's preset,
// resolved exactly like the offline renderer (resolveTrackPreset over the renderer SoundFont), with the track's fader + pan.
import sf2ProcessorUrl from "../sf2-processor.ts?worker&url";
import type { WorkstationController } from "./controller.ts";
import type { LiveSink } from "./live-input.ts";
import { loadSoundFont } from "../audio/soundfont-loader.ts";
import { resolveTrackPreset } from "../audio/offline-renderer.ts";

export class Sf2LiveSink implements LiveSink {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private pan: StereoPannerNode | null = null;
  private boot: Promise<void> | null = null;
  private presetKey = "";
  error: string | null = null;
  constructor(private c: WorkstationController) {}

  /** Create/resume the AudioContext (call from a user gesture) and load the worklet + SoundFont. */
  prepare(): Promise<void> {
    if (this.ctx && this.ctx.state === "suspended") void this.ctx.resume();
    if (this.boot) return this.boot;
    this.boot = (async () => {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      this.ctx = ctx;
      await ctx.audioWorklet.addModule(sf2ProcessorUrl);
      const node = new AudioWorkletNode(ctx, "sf2-processor", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      this.gain = ctx.createGain(); this.pan = ctx.createStereoPanner();
      node.connect(this.gain).connect(this.pan).connect(ctx.destination);
      this.node = node;
      await loadSoundFont();
      if (ctx.state !== "running") await ctx.resume().catch(() => undefined);
    })().catch((e) => { this.error = (e as Error).message; this.boot = null; throw e; });
    return this.boot;
  }
  get ready(): boolean { return !!this.node; }
  get latencyMs(): number | null { return this.ctx ? Math.round(((this.ctx.baseLatency ?? 0) + ((this.ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0)) * 1000) : null; }

  /** Point the engine at the track's preset (renderer parity) and its mix. Cheap when nothing changed. */
  private async sync(trackId: string) {
    const sf = await loadSoundFont();
    const p = this.c.project; const t = p.tracks.find((x) => x.id === trackId); if (!t || !this.node || !this.ctx) return;
    const now = this.ctx.currentTime, ov = this.c.getState().overrides[t.id] ?? {};
    const vol = ov.volume ?? t.mix.volume, pan = ov.pan ?? t.mix.pan;
    this.gain!.gain.setValueAtTime(t.mix.mute ? 0 : (vol / 100) ** 2, now);
    this.pan!.pan.setValueAtTime(Math.max(-1, Math.min(1, (pan - 64) / 63)), now);
    const r = resolveTrackPreset(p, trackId, sf.sf);
    const key = `${trackId}:${r?.presetIndex}`;
    if (r && key !== this.presetKey) { this.presetKey = key; this.node.port.postMessage({ type: "setPreset", channel: 0, regions: r.regions }); }
  }
  private post(trackId: string, msg: Record<string, unknown>) {
    if (this.node && this.presetKey.startsWith(`${trackId}:`)) { this.node.port.postMessage(msg); return; } // hot path: no awaits
    void this.prepare().then(() => this.sync(trackId)).then(() => this.node?.port.postMessage(msg)).catch(() => undefined);
  }
  noteOn(trackId: string, note: number, velocity: number) { this.post(trackId, { type: "noteOn", channel: 0, note, velocity }); }
  noteOff(trackId: string, note: number) { this.post(trackId, { type: "noteOff", channel: 0, note }); }
  controlChange(trackId: string, controller: number, value: number) { this.post(trackId, { type: "controlChange", channel: 0, controller, value }); }
  pitchBend(trackId: string, value: number) { this.post(trackId, { type: "pitchBend", channel: 0, velocity: value }); }
  allNotesOff() { this.node?.port.postMessage({ type: "controlChange", channel: 0, controller: 64, value: 0 }); this.node?.port.postMessage({ type: "controlChange", channel: 0, controller: 123, value: 0 }); }
  /** Re-sync preset + mix after track selection / mix changes. */
  refresh(trackId: string | null) { if (trackId && this.node) void this.sync(trackId); }
}
