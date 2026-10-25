// Worker side of the parallel offline renderer (parallel-render.ts). Each worker owns a few tracks and runs the same
// Sf2ProcessorCore the sf2-processor AudioWorklet runs, so a track renders sample-for-sample like it does inside the
// OfflineAudioContext. Output goes back per track in fixed-size chunks; the main thread mixes them in track order.
// Backpressure: a worker may be at most `maxAhead` chunks ahead of the mix, so memory stays bounded no matter how
// uneven the tracks are. Kept free of Worker globals so tests can drive it with an in-process fake.
import { Sf2ProcessorCore } from "../sf2-processor-core.ts";
import type { SynthEvent, TrackState } from "../sf2-renderer.ts";

const QUANTUM = 128;

export interface TrackRenderInit {
  type: "init"; sampleRate: number; totalFrames: number; chunkFrames: number; maxAhead: number;
  tracks: { track: TrackState; events: SynthEvent[] }[];
}
export type ToWorker = TrackRenderInit | { type: "credit" };
export type FromWorker =
  | { type: "chunk"; chunk: number; tracks: number[]; L: Float32Array[]; R: Float32Array[] }
  | { type: "done" }
  | { type: "error"; message: string };

export interface WorkerScope {
  postMessage(m: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((e: { data: ToWorker }) => void) | null;
}

export function runTrackRenderWorker(scope: WorkerScope): void {
  let credits = 0; let wake: (() => void) | null = null;
  scope.onmessage = (e) => {
    const m = e.data;
    if (m.type === "credit") { credits++; const w = wake; wake = null; w?.(); return; }
    if (m.type === "init") void run(m);
  };
  async function run(m: TrackRenderInit) {
    try {
      const cores = m.tracks.map(({ track, events }) => {
        const c = new Sf2ProcessorCore(m.sampleRate);
        c.onMsg({ type: "setOfflineTracks", tracks: [track], maxVoices: 64 } as SynthEvent);
        c.onMsg({ type: "setSequence", events } as SynthEvent);
        return c;
      });
      const ids = m.tracks.map((t) => t.track.trackIndex);
      const chunks = Math.ceil(m.totalFrames / m.chunkFrames);
      credits = m.maxAhead;
      for (let ci = 0; ci < chunks; ci++) {
        while (credits <= 0) await new Promise<void>((res) => { wake = res; });
        credits--;
        const n = Math.min(m.chunkFrames, m.totalFrames - ci * m.chunkFrames);
        const L: Float32Array[] = [], R: Float32Array[] = [];
        for (const core of cores) {
          const l = new Float32Array(n), r = new Float32Array(n);
          // Same 128-frame quanta as the worklet (the engine is per-sample, so the last partial quantum is identical).
          for (let f = 0; f < n; f += QUANTUM) core.process(l.subarray(f, f + QUANTUM), r.subarray(f, f + QUANTUM));
          L.push(l); R.push(r);
        }
        scope.postMessage({ type: "chunk", chunk: ci, tracks: ids, L, R }, [...L.map((a) => a.buffer), ...R.map((a) => a.buffer)]);
      }
      scope.postMessage({ type: "done" });
    } catch (err) {
      scope.postMessage({ type: "error", message: (err as Error)?.message ?? String(err) });
    }
  }
}
