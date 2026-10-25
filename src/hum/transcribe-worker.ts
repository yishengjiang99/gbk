// Basic Pitch transcription worker: owns the onnxruntime-web session for the
// pinned ICASSP 2022 ONNX model (see scripts/prepare-hum-model.mjs) so model
// inference never blocks the UI thread. The WASM runtime files are the ones
// staged same-origin by scripts/prepare-ort-runtime.mjs (public/ort-runtime/).
import * as ort from "onnxruntime-web";
import { transcribeSamples, type TimedNote } from "./transcribe-core.ts";

const INPUT_NAME = "serving_default_input_2:0";
const NOTE_OUTPUT = "StatefulPartitionedCall:1";
const ONSET_OUTPUT = "StatefulPartitionedCall:2";

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function getSession(modelUrl: string, wasmPaths: string): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    ort.env.wasm.wasmPaths = wasmPaths;
    sessionPromise = (async () => {
      const res = await fetch(modelUrl);
      if (!res.ok) throw new Error(`Could not load the transcription model (${res.status})`);
      const bytes = await res.arrayBuffer();
      return ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
    })();
    // A failed load should not poison later attempts.
    sessionPromise.catch(() => { sessionPromise = null; });
  }
  return sessionPromise;
}

interface TranscribeMsg {
  t: "transcribe"; id: number; samples: Float32Array; modelUrl: string; wasmPaths: string;
}

self.onmessage = async (e: MessageEvent<TranscribeMsg>) => {
  const m = e.data;
  if (!m || m.t !== "transcribe") return;
  try {
    const session = await getSession(m.modelUrl, m.wasmPaths);
    const notes: TimedNote[] = await transcribeSamples(m.samples, async (win) => {
      const input = new ort.Tensor("float32", win, [1, win.length, 1]);
      const out = await session.run({ [INPUT_NAME]: input }, [NOTE_OUTPUT, ONSET_OUTPUT]);
      return {
        note: out[NOTE_OUTPUT].data as Float32Array,
        onset: out[ONSET_OUTPUT].data as Float32Array,
      };
    }, { onProgress: (frac) => self.postMessage({ t: "progress", id: m.id, frac }) });
    self.postMessage({ t: "done", id: m.id, notes });
  } catch (err) {
    self.postMessage({ t: "error", id: m.id, error: err instanceof Error ? err.message : String(err) });
  }
};
