// Main-thread client for the Basic Pitch transcription worker, plus the
// 22,050 Hz mono resampling every input (mic capture or an injected buffer)
// goes through before inference.
import { BP_SAMPLE_RATE, type TimedNote } from "./transcribe-core.ts";

export type { TimedNote };

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (n: TimedNote[]) => void; reject: (e: Error) => void; onProgress?: (f: number) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./transcribe-worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data as { t: string; id: number; notes?: TimedNote[]; error?: string; frac?: number };
    const p = pending.get(m.id);
    if (!p) return;
    if (m.t === "progress") { p.onProgress?.(m.frac ?? 0); return; }
    pending.delete(m.id);
    if (m.t === "done") p.resolve(m.notes ?? []);
    else p.reject(new Error(m.error || "Transcription failed"));
  };
  worker.onerror = (e) => {
    const err = new Error(`Transcription worker failed: ${e.message || "unknown error"}`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker = null;
  };
  return worker;
}

/** Transcribe mono samples already at 22,050 Hz. */
export function transcribe(samples: Float32Array, onProgress?: (fraction: number) => void): Promise<TimedNote[]> {
  const id = ++seq;
  const base = import.meta.env.BASE_URL || "/";
  const modelUrl = new URL(`${base}hum-models/basic-pitch.onnx`, location.origin).href;
  const wasmPaths = new URL(`${base}ort-runtime/`, location.origin).href;
  return new Promise<TimedNote[]>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ t: "transcribe", id, samples, modelUrl, wasmPaths }, [samples.buffer]);
  });
}

/** Resample any AudioBuffer to mono 22,050 Hz Float32Array (OfflineAudioContext does the anti-aliased conversion). */
export async function resampleToBasicPitch(buffer: AudioBuffer): Promise<Float32Array> {
  if (buffer.sampleRate === BP_SAMPLE_RATE && buffer.numberOfChannels === 1) {
    return buffer.getChannelData(0).slice();
  }
  const len = Math.max(1, Math.round((buffer.duration * BP_SAMPLE_RATE)));
  const offline = new OfflineAudioContext(1, len, BP_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}
