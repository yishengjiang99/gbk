// Parallel offline render: the same per-track Sf2ProcessorCore engines the OfflineAudioContext graph runs, spread
// over a small pool of Web Workers instead of one audio render thread.
//
// Why: an OfflineAudioContext renders its whole graph on ONE thread, and every track here is an AudioWorkletNode
// running JavaScript, so N tracks cost N x (one track) of wall-clock time on one core. The graph after the engines
// is purely linear (splitter -> 4 gains -> merger), so nothing needs the audio thread: each track renders in a
// worker and the main thread applies the same gain matrix. Mixing is done strictly in track order with the same
// float32 rounding as the graph, so the result does not depend on the number of workers or on scheduling.
import type { SynthEvent, TrackState } from "../sf2-renderer.ts";
import type { FromWorker, ToWorker } from "./track-render-worker-core.ts";
import { RenderError } from "./render-error.ts";

/** One audible track: its engine state, its events, and its [fromChannel, toChannel, gain] mix matrix (zero gains omitted). */
export interface PlanVoice { t: TrackState; events: SynthEvent[]; gains: [number, number, number][] }

export interface WorkerLike {
  postMessage(m: ToWorker): void;
  onmessage: ((e: { data: FromWorker }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  terminate(): void;
}
export type SpawnWorker = () => WorkerLike;

export interface ParallelControl {
  signal?: AbortSignal; onProgress?: (x: number) => void;
  stallMs: number; timeoutMs: number;
  /** Worker pool size. Default: hardwareConcurrency - 1, capped at 8 and at the number of tracks. */
  workers?: number;
  /** Frames per chunk sent back by the workers (default 1 s at 48 kHz). */
  chunkFrames?: number;
  /** How many chunks a worker may run ahead of the mix (bounds memory). Default 4. */
  maxAhead?: number;
}

/** Thrown when the pool could not start at all; the caller falls back to the OfflineAudioContext path. */
export class ParallelUnavailable extends Error { constructor(m: string) { super(m); this.name = "ParallelUnavailable"; } }

/** Web Worker factory for the browser, or null where workers are unavailable (Node tests, the esbuild widget bundle). */
export async function browserWorkerSpawn(): Promise<SpawnWorker | null> {
  if (typeof Worker === "undefined") return null;
  let url = "";
  try {
    // @ts-ignore Vite query import (the widget build stubs this to "")
    url = ((await import("./track-render.worker.ts?worker&url")) as { default: string }).default;
  } catch { return null; }
  if (!url) return null;
  return () => new Worker(url, { type: "module", name: "gbk-track-render" }) as unknown as WorkerLike;
}

export function defaultWorkerCount(tracks: number): number {
  const hc = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(tracks, hc - 1, 8));
}

export async function renderPlanParallel(voices: PlanVoice[], sampleRate: number, totalFrames: number, spawn: SpawnWorker, o: ParallelControl): Promise<{ L: Float32Array; R: Float32Array }> {
  if (o.signal?.aborted) throw new RenderError("OPERATION_CANCELLED", "cancelled");
  const L = new Float32Array(totalFrames), R = new Float32Array(totalFrames);
  if (!voices.length) { o.onProgress?.(1); return { L, R }; }
  const chunkFrames = Math.max(128, Math.round((o.chunkFrames ?? 48000) / 128) * 128);
  const chunks = Math.ceil(totalFrames / chunkFrames);
  const W = Math.max(1, Math.min(o.workers ?? defaultWorkerCount(voices.length), voices.length));

  // Longest-processing-time assignment by note count (the per-voice loop dominates the cost).
  const load = new Array<number>(W).fill(0);
  const groups: number[][] = Array.from({ length: W }, () => []);
  const weight = (v: PlanVoice) => 1 + v.events.reduce((n, e) => n + (e.type === "noteOn" ? 1 : 0), 0);
  [...voices.keys()].sort((a, b) => weight(voices[b]) - weight(voices[a]) || a - b).forEach((vi) => {
    let w = 0; for (let k = 1; k < W; k++) if (load[k] < load[w]) w = k;
    groups[w].push(vi); load[w] += weight(voices[vi]);
  });
  const slot = new Map<number, number>(); // trackIndex -> position in `voices` (mix order)
  voices.forEach((v, i) => slot.set(v.t.trackIndex, i));

  const workers: WorkerLike[] = [];
  return await new Promise<{ L: Float32Array; R: Float32Array }>((resolve, reject) => {
    let done = false; let mixed = 0; let last = Date.now(); const t0 = Date.now();
    const staged = new Map<number, { L: Float32Array; R: Float32Array }[]>(); // chunk -> per-voice output
    const stagedCount = new Map<number, number>();
    const finish = (e: Error | null) => {
      if (done) return; done = true; clearInterval(watch); o.signal?.removeEventListener("abort", onAbort);
      for (const w of workers) { try { w.terminate(); } catch { /* gone */ } }
      if (e) reject(e); else { o.onProgress?.(1); resolve({ L, R }); }
    };
    const fail = (msg: string) => finish(mixed === 0 ? new ParallelUnavailable(msg) : new RenderError("INTERNAL_ERROR", `parallel render failed: ${msg}`));
    const onAbort = () => finish(new RenderError("OPERATION_CANCELLED", "cancelled"));
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const seconds = totalFrames / sampleRate;
    const watch = setInterval(() => {
      const now = Date.now();
      if (now - t0 > o.timeoutMs) finish(new RenderError("RENDER_TIMEOUT", `rendering ${seconds.toFixed(0)} s of audio took longer than ${Math.round(o.timeoutMs / 1000)} s; cancelled`));
      else if (now - last > o.stallMs) fail(`no progress for ${Math.round(o.stallMs / 1000)} s`);
    }, 1000);

    const mixReady = () => {
      // Mix chunk `mixed` once every voice has delivered it, always in voice order: the float32 rounding is then
      // exactly the graph's (gain output rounded to float32, merger input accumulated in connection order).
      while (stagedCount.get(mixed) === voices.length) {
        const outs = staged.get(mixed)!; staged.delete(mixed); stagedCount.delete(mixed);
        const off = mixed * chunkFrames;
        for (let vi = 0; vi < voices.length; vi++) {
          const src = outs[vi];
          for (const [from, to, g] of voices[vi].gains) {
            const s = from === 0 ? src.L : src.R; const d = to === 0 ? L : R; const n = s.length;
            for (let k = 0; k < n; k++) d[off + k] += Math.fround(s[k] * g);
          }
        }
        mixed++; last = Date.now();
        o.onProgress?.(mixed / chunks);
        for (const w of workers) w.postMessage({ type: "credit" });
      }
      if (mixed === chunks) finish(null);
    };

    try {
      for (let wi = 0; wi < W; wi++) {
        const w = spawn(); workers.push(w);
        w.onerror = (e) => fail((e as { message?: string })?.message || "worker failed to load");
        w.onmessage = (e) => {
          if (done) return;
          const m = e.data;
          if (m.type === "error") return fail(m.message);
          if (m.type !== "chunk") return;
          let outs = staged.get(m.chunk); if (!outs) { outs = new Array(voices.length); staged.set(m.chunk, outs); }
          m.tracks.forEach((ti, k) => { outs![slot.get(ti)!] = { L: m.L[k], R: m.R[k] }; });
          stagedCount.set(m.chunk, (stagedCount.get(m.chunk) ?? 0) + m.tracks.length);
          mixReady();
        };
        w.postMessage({ type: "init", sampleRate, totalFrames, chunkFrames, maxAhead: Math.max(1, o.maxAhead ?? 4),
          tracks: groups[wi].map((vi) => ({ track: voices[vi].t, events: voices[vi].events })) });
      }
    } catch (e) { fail((e as Error).message); }
  });
}
