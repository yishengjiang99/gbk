// Browser LiveSink: a dedicated low-latency SF2 AudioWorklet engine that always plays the workstation's selected track,
// with that track's preset resolved exactly like the offline renderer (resolveTrackPreset over the renderer SoundFont)
// and its fader + pan. Selection, program/bank and mix changes re-point the engine immediately.
import type { WorkstationController } from "./controller.ts";
import type { LiveSink } from "./live-input.ts";
import { selectedTrackId } from "./live-input.ts";
import { loadSoundFont, peekSoundFont } from "../audio/soundfont-loader.ts";
import { resolveTrackPreset } from "../audio/offline-renderer.ts";
import { synthEvent } from "../synth-ingress.ts";
import type { SynthEvent } from "../sf2-renderer.ts";
import { reportError } from "../telemetry/error-reporter.ts";

/** LiveGraph.post is loosely typed; the synthEvent builders produce the exact wire shapes. */
const asMsg = (e: SynthEvent): Record<string, unknown> => e as unknown as Record<string, unknown>;

/** The audio side (Web Audio in the browser, a fake in tests). */
export interface LiveGraph { post(msg: Record<string, unknown>): void; setMix(gain: number, pan: number): void; readonly latencyMs: number | null; readonly state: string; resume(): void }

export async function createWebAudioGraph(): Promise<LiveGraph> {
  // Dynamic so node tests (fake graph) never resolve the Vite worker URL.
  // @ts-ignore Vite query import (typed in vite-env.d.ts for static imports only)
  const { default: url } = (await import("../sf2-processor.ts?worker&url")) as { default: string };
  const ctx = new AudioContext({ latencyHint: "interactive" });
  await ctx.audioWorklet.addModule(url);
  const node = new AudioWorkletNode(ctx, "sf2-processor", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  // Same shape as the player graph: the worklet is the only node; mix lives in the engine's track stage.
  node.connect(ctx.destination);
  if (ctx.state !== "running") await ctx.resume().catch(() => undefined);
  return {
    post: (m) => node.port.postMessage(m),
    setMix: (g, p) => {
      node.port.postMessage({ type: "setTrackFader", gain: g });
      node.port.postMessage({ type: "setTrackPan", pan: p });
    },
    get latencyMs() { return Math.round(((ctx.baseLatency ?? 0) + ((ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0)) * 1000); },
    get state() { return ctx.state; },
    resume: () => { if (ctx.state === "suspended") void ctx.resume(); },
    // debug handle for headless checks
    ...({ ctx } as object),
  } as LiveGraph;
}

export interface LiveInstrument { trackId: string; presetName: string; presetIndex: number; bank: number; program: number }

export class Sf2LiveSink implements LiveSink {
  graph: LiveGraph | null = null;
  private boot: Promise<void> | null = null;
  private presetIndex = -1;
  /** Track + preset the engine is currently set to. */
  current: LiveInstrument | null = null;
  error: string | null = null;
  constructor(private c: WorkstationController, private makeGraph: () => Promise<LiveGraph> = createWebAudioGraph) {
    c.subscribe(() => this.refresh());
  }

  /** Create/resume the audio graph (call from a user gesture) and load the SoundFont. */
  prepare(): Promise<void> {
    this.graph?.resume();
    if (this.boot) return this.boot;
    this.boot = (async () => {
      const [g] = await Promise.all([this.makeGraph(), loadSoundFont()]);
      this.graph = g; this.error = null; this.refresh();
    })().catch((e) => { this.error = (e as Error).message; this.boot = null; throw e; });
    return this.boot;
  }
  get ready(): boolean { return !!this.graph; }
  get latencyMs(): number | null { return this.graph?.latencyMs ?? null; }

  /** The track's instrument exactly as the renderer resolves it (null until the SoundFont is loaded). */
  describe(trackId: string | null): LiveInstrument | null {
    const sf = peekSoundFont(); if (!sf || !trackId) return null;
    const r = resolveTrackPreset(this.c.project, trackId, sf.sf);
    return r ? { trackId, presetName: r.presetName, presetIndex: r.presetIndex, bank: r.bank, program: r.program } : null;
  }
  /** Synchronously point the engine at the track's current preset + mix. Cheap: regions are cached per preset. */
  private apply(trackId: string): boolean {
    const sf = peekSoundFont(); const g = this.graph; const t = this.c.project.tracks.find((x) => x.id === trackId);
    if (!sf || !g || !t) return false;
    const r = resolveTrackPreset(this.c.project, trackId, sf.sf); if (!r) return false;
    const ov = this.c.getState().overrides[t.id] ?? {};
    g.setMix(t.mix.mute ? 0 : ((ov.volume ?? t.mix.volume) / 100) ** 2, Math.max(-1, Math.min(1, ((ov.pan ?? t.mix.pan) - 64) / 63)));
    if (r.presetIndex !== this.presetIndex) {
      if (this.current && this.current.trackId !== trackId) this.allNotesOff(); // don't leave the old instrument hanging
      this.presetIndex = r.presetIndex; g.post(asMsg(synthEvent.setPreset(r.regions, 0)));
    }
    this.current = { trackId, presetName: r.presetName, presetIndex: r.presetIndex, bank: r.bank, program: r.program };
    return true;
  }
  private post(trackId: string, msg: Record<string, unknown>) {
    if (this.apply(trackId)) { this.graph!.post(msg); return; } // hot path: synchronous
    void this.prepare().then(() => { if (this.apply(trackId)) this.graph?.post(msg); }).catch((e) => reportError(e, { where: "live-sink.prepare" }));
  }
  noteOn(trackId: string, note: number, velocity: number) { this.post(trackId, asMsg(synthEvent.noteOn(0, note, velocity))); }
  noteOff(_trackId: string, note: number) { this.graph?.post(asMsg(synthEvent.noteOff(0, note))); } // never re-points the engine
  controlChange(trackId: string, controller: number, value: number) { this.post(trackId, asMsg(synthEvent.controlChange(0, controller, value))); }
  pitchBend(trackId: string, value: number) { this.post(trackId, asMsg(synthEvent.pitchBend(0, value))); }
  allNotesOff() { this.graph?.post(asMsg(synthEvent.controlChange(0, 64, 0))); this.graph?.post(asMsg(synthEvent.controlChange(0, 123, 0))); }
  /** Re-point at the selected track (selection / program / mix changed). */
  refresh(trackId: string | null = selectedTrackId(this.c.project)) { if (trackId) this.apply(trackId); }
}
