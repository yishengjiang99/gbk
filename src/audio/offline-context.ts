// The ONLY place WAV audio is synthesized: an OfflineAudioContext in the user's browser, running the same
// sf2-processor AudioWorklet (Sf2SynthEngine) as realtime playback. Graph per audible track, mirroring the player:
//   AudioWorkletNode("sf2-processor") -> ChannelSplitter -> 4 GainNodes (pan/fader matrix) -> shared ChannelMerger -> destination.
// Progress, cancellation and stall detection use OfflineAudioContext.suspend(): the render thread pauses every
// PROGRESS_SECONDS of audio; we report progress and only resume() if the job is still wanted, so Stop really halts
// synthesis (an abandoned context stays suspended and is garbage-collected). iOS Safari: webkitOfflineAudioContext
// fallback, positional constructor, startRendering() promise or oncomplete event.
import type { RenderPlan } from "./offline-renderer.ts";
import { RenderError } from "./render-error.ts";
import { stereoPanGains } from "./orchestra-pan.ts";
import type { SynthEvent } from "../sf2-renderer.ts";

export const PROCESSOR_NAME = "sf2-processor";
const QUANTUM = 128;
const PROGRESS_SECONDS = 2;

/** The slice of the Web Audio API the renderer uses (real browser objects satisfy it; tests use a stand-in). */
export interface OfflineCtx {
  readonly sampleRate: number; readonly length: number; readonly destination: AudioNode;
  readonly audioWorklet?: { addModule(url: string): Promise<void> };
  createChannelSplitter(n: number): ChannelSplitterNode; createChannelMerger(n: number): ChannelMergerNode; createGain(): GainNode;
  startRendering(): Promise<AudioBuffer> | void;
  suspend?(t: number): Promise<void>; resume(): Promise<void>;
  oncomplete?: ((e: { renderedBuffer: AudioBuffer }) => void) | null;
}
export interface OfflineEnv {
  createContext(channels: number, length: number, sampleRate: number): OfflineCtx;
  createWorkletNode(ctx: OfflineCtx, name: string, options: AudioWorkletNodeOptions): AudioWorkletNode;
  workletUrl(): Promise<string>;
}

type G = { OfflineAudioContext?: new (c: number, l: number, sr: number) => OfflineCtx; webkitOfflineAudioContext?: new (c: number, l: number, sr: number) => OfflineCtx;
  AudioWorkletNode?: new (ctx: OfflineCtx, name: string, o: AudioWorkletNodeOptions) => AudioWorkletNode; __gbkSf2WorkletUrl?: string };

/** The browser's OfflineAudioContext (or webkitOfflineAudioContext on older iOS Safari). Throws RENDER_UNSUPPORTED otherwise. */
export function browserOfflineEnv(): OfflineEnv {
  const g = globalThis as unknown as G;
  const Ctor = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
  if (!Ctor) throw new RenderError("RENDER_UNSUPPORTED", "this browser has no OfflineAudioContext; WAV rendering happens only in the browser - use a current Safari, Chrome, Firefox or Edge");
  return {
    createContext: (c, l, sr) => new Ctor(c, l, sr),
    createWorkletNode: (ctx, name, o) => {
      if (!g.AudioWorkletNode) throw new RenderError("RENDER_UNSUPPORTED", "this browser has no AudioWorklet (Safari/iOS 14.5 or newer is required to render WAV)");
      return new g.AudioWorkletNode(ctx, name, o);
    },
    workletUrl: async () => {
      if (g.__gbkSf2WorkletUrl) return g.__gbkSf2WorkletUrl;
      // @ts-ignore Vite query import (typed in vite-env.d.ts for static imports only)
      return ((await import("../sf2-processor.ts?worker&url")) as { default: string }).default;
    },
  };
}

export interface OfflineRenderControl {
  signal?: AbortSignal; onProgress?: (x: number) => void;
  /** Fail with RENDER_STALLED when the audio thread makes no progress for this long. Default 45 s. */
  stallMs?: number;
  /** Fail with RENDER_TIMEOUT after this long overall. Default 60 s + 3x the audio length (cap 60 min). */
  timeoutMs?: number;
  env?: OfflineEnv;
}

const ms = (x: number) => `${Math.round(x / 1000)} s`;

/** Render the plan to planar float stereo with an OfflineAudioContext. Rejects with a RenderError on cancel/stall/timeout. */
export async function renderPlanOffline(plan: RenderPlan, sampleRate: number, totalFrames: number, o: OfflineRenderControl = {}): Promise<{ L: Float32Array; R: Float32Array }> {
  const env = o.env ?? browserOfflineEnv();
  const aborted = () => o.signal?.aborted;
  if (aborted()) throw new RenderError("OPERATION_CANCELLED", "cancelled");
  const seconds = totalFrames / sampleRate;
  const timeoutMs = o.timeoutMs ?? Math.min(60 * 60_000, 60_000 + seconds * 3000);
  const stallMs = o.stallMs ?? 45_000;
  let ctx: OfflineCtx;
  try { ctx = env.createContext(2, totalFrames, sampleRate); }
  catch (e) { throw new RenderError("RENDER_TOO_LARGE", `the browser could not create a ${seconds.toFixed(0)} s offline audio buffer at ${sampleRate} Hz (${(e as Error).message})`); }
  if (!ctx.audioWorklet) throw new RenderError("RENDER_UNSUPPORTED", "this browser's OfflineAudioContext has no AudioWorklet (Safari/iOS 14.5 or newer is required to render WAV)");
  await ctx.audioWorklet.addModule(await env.workletUrl());

  // One engine per audible track, events routed exactly as before (trackIndex < 0 -> every engine).
  const hasNotes = new Set<number>();
  for (const e of plan.events) if (e.type === "noteOn") hasNotes.add(e.trackIndex ?? -1);
  const voices = plan.tracks.filter((t) => (t.gain ?? 1) > 0 && hasNotes.has(t.trackIndex)).map((t) => ({ t, events: [] as SynthEvent[] }));
  const byTrack = new Map(voices.map((v) => [v.t.trackIndex, v]));
  for (const e of plan.events) { const ti = e.trackIndex ?? -1; if (ti < 0) for (const v of voices) v.events.push(e); else byTrack.get(ti)?.events.push(e); }

  const merger = ctx.createChannelMerger(2);
  merger.connect(ctx.destination);
  const ready: Promise<void>[] = [];
  for (const v of voices) {
    const node = env.createWorkletNode(ctx, PROCESSOR_NAME, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    ready.push(new Promise<void>((res) => { node.port.onmessage = (ev: MessageEvent) => { if ((ev.data as { type?: string })?.type === "sequenceReady") res(); }; }));
    node.port.postMessage({ type: "setOfflineTracks", tracks: [v.t], maxVoices: 64 });
    node.port.postMessage({ type: "setSequence", events: v.events });
    const k = plan.faders[v.t.trackIndex] ?? 1; const g = stereoPanGains(plan.pans[v.t.trackIndex] ?? 0);
    const split = ctx.createChannelSplitter(2); node.connect(split);
    for (const [from, to, gain] of [[0, 0, g.ll], [1, 0, g.rl], [0, 1, g.lr], [1, 1, g.rr]] as const) {
      if (!gain) continue;
      const gn = ctx.createGain(); gn.gain.value = gain * k; split.connect(gn, from); gn.connect(merger, 0, to);
    }
  }
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all(ready), new Promise((_, rej) => { readyTimer = setTimeout(() => rej(new RenderError("RENDER_STALLED", "the SF2 audio worklet did not start in the offline audio context within 15 s")), 15_000); })])
    .finally(() => clearTimeout(readyTimer));
  if (aborted()) throw new RenderError("OPERATION_CANCELLED", "cancelled");

  return await new Promise<{ L: Float32Array; R: Float32Array }>((resolve, reject) => {
    let done = false; let last = Date.now(); const t0 = Date.now();
    const canSuspend = typeof ctx.suspend === "function";
    const finish = (e: Error | null, buf?: AudioBuffer) => {
      if (done) return; done = true; clearInterval(watch); o.signal?.removeEventListener("abort", onAbort);
      if (e) reject(e); else resolve({ L: buf!.getChannelData(0), R: buf!.numberOfChannels > 1 ? buf!.getChannelData(1) : buf!.getChannelData(0) });
    };
    const onAbort = () => finish(new RenderError("OPERATION_CANCELLED", "cancelled"));
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const watch = setInterval(() => {
      const now = Date.now();
      if (now - t0 > timeoutMs) finish(new RenderError("RENDER_TIMEOUT", `rendering ${seconds.toFixed(0)} s of audio took longer than ${ms(timeoutMs)}; cancelled`));
      else if (canSuspend && now - last > stallMs) finish(new RenderError("RENDER_STALLED", `the offline audio render made no progress for ${ms(stallMs)}; cancelled`));
    }, 1000);
    // Progress checkpoints (also the cancellation points): suspend every PROGRESS_SECONDS of audio.
    const step = Math.max(QUANTUM, Math.round((PROGRESS_SECONDS * sampleRate) / QUANTUM) * QUANTUM);
    const checkpoint = (frame: number) => {
      if (!canSuspend || frame >= totalFrames - QUANTUM) return;
      let p: Promise<void>;
      try { p = ctx.suspend!(frame / sampleRate); } catch { return; } // older engines: no progress, still renders
      p.then(() => {
        last = Date.now();
        if (done) return; // cancelled / timed out: never resume -> the audio thread stops here
        o.onProgress?.(frame / totalFrames);
        checkpoint(frame + step);
        void ctx.resume();
      }, () => undefined);
    };
    checkpoint(step);
    let r: Promise<AudioBuffer> | void;
    try { r = ctx.startRendering(); } catch (e) { finish(new RenderError("INTERNAL_ERROR", `offline render failed to start: ${(e as Error).message}`)); return; }
    if (r && typeof (r as Promise<AudioBuffer>).then === "function") (r as Promise<AudioBuffer>).then((b) => { o.onProgress?.(1); finish(null, b); }, (e) => finish(new RenderError("INTERNAL_ERROR", `offline render failed: ${(e as Error)?.message ?? e}`)));
    else ctx.oncomplete = (e) => { o.onProgress?.(1); finish(null, e.renderedBuffer); };
  });
}
