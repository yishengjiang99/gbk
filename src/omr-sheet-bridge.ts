/*
 * Bridge between the gbk sheet-cam UI and the omr-homr-web Worker (AGPL-3.0).
 *
 * The camera button captures a photo -> this module sends it to the OMR
 * worker via the `transcribe-page` JSON protocol -> the worker returns SMF
 * MIDI bytes plus a note layout -> we reshape that into the existing
 * ParsedSheetMusicWithLayout so playback, the playlist, persistence, and
 * note highlighting reuse the OCR path untouched.
 *
 * The OMR models are NOT bundled with the app (they are ~150MB and
 * gitignored inside omr-homr-web/models/). They must be hosted at
 * OMR_MODEL_BASE_URL (default `/omr-models/`, e.g. copied from
 * `omr-homr-web/models/` after `npm run fetch:models` there, or served from
 * any static host/CND by overriding the constant). When the models are
 * unreachable, or transcription fails, the caller falls back to the built-in
 * OCR reader -- the camera button keeps working either way.
 *
 * Protocol shapes below mirror omr-homr-web/src/worker.ts; the page never
 * imports homr code or weights directly.
 */
import type {
  ParsedSheetMusicWithLayout,
  SheetMusicNoteBox,
  SheetMusicNoteLayout,
} from "./sheet-music-reader.ts";

/** Base URL the OMR model files are served from. Override for CDN hosting. */
export const OMR_MODEL_BASE_URL = "/omr-models/";

/** Pinned onnxruntime-web release serving the WASM runtime files. */
const ORT_WASM_CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";

/** Upper bound for one transcription (model download + SegNet + decode). */
const TRANSCRIBE_TIMEOUT_MS = 600_000;

interface OmrPageMapping {
  srcWidth: number;
  srcHeight: number;
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
  pageWidth: number;
  pageHeight: number;
}

interface OmrNoteLayoutEntry {
  pitch: number;
  startSec: number;
  endSec: number;
  box: { x: number; y: number; w: number; h: number } | null;
}

interface OmrPageResult {
  midi: ArrayBuffer;
  noteLayout: OmrNoteLayoutEntry[];
  layoutSource: "attention" | "midi-fallback";
  staffCount: number;
  warnings: string[];
  pageMapping?: OmrPageMapping;
}

type OmrWorkerMessage =
  | { type: "ready"; webgpu: boolean }
  | { type: "progress"; stage: string }
  | ({ type: "result" } & OmrPageResult)
  | { type: "error"; message: string };

export function omrModelUrls(base: string = OMR_MODEL_BASE_URL): {
  encoderUrl: string;
  decoderUrl: string;
  segnetUrl: string;
} {
  const webgpu = typeof navigator !== "undefined" && "gpu" in navigator;
  return {
    encoderUrl: base + (webgpu ? "transformer_encoder_model_fp16.onnx" : "transformer_encoder_model_fp32.onnx"),
    decoderUrl: base + "transformer_decoder_model_fp32.onnx",
    segnetUrl: base + "segnet_model_fp16.onnx",
  };
}

/** Probe (cached) for whether the OMR models are reachable from this page. */
let modelProbe: Promise<boolean> | null = null;
export function isOmrModelAvailable(): Promise<boolean> {
  if (!modelProbe) {
    modelProbe = (async () => {
      try {
        const res = await fetch(omrModelUrls().encoderUrl, { method: "HEAD" });
        return res.ok;
      } catch {
        return false;
      }
    })();
  }
  return modelProbe;
}

/** Map a preprocessed-page box back onto source-photo pixels. */
export function mapBoxToPhoto(
  box: { x: number; y: number; w: number; h: number },
  mapping: OmrPageMapping,
): SheetMusicNoteBox {
  const scaleX = mapping.cropW / mapping.pageWidth;
  const scaleY = mapping.cropH / mapping.pageHeight;
  return {
    x: mapping.cropX + box.x * scaleX,
    y: mapping.cropY + box.y * scaleY,
    w: box.w * scaleX,
    h: box.h * scaleY,
  };
}

const ZERO_BOX: SheetMusicNoteBox = { x: 0, y: 0, w: 0, h: 0 };

/** Reshape a worker `transcribe-page` result into the app's scan shape. */
export function omrResultToScanResult(
  fileName: string,
  photoWidth: number,
  photoHeight: number,
  result: OmrPageResult,
): ParsedSheetMusicWithLayout {
  const mapping = result.pageMapping;
  const noteLayout: SheetMusicNoteLayout[] = result.noteLayout.map((entry) => ({
    pitch: entry.pitch,
    startSec: entry.startSec,
    endSec: entry.endSec,
    // Without the page mapping (older worker) boxes cannot be placed on the
    // photo; emit a zero box so highlighting degrades to playback-only.
    bbox: entry.box && mapping ? mapBoxToPhoto(entry.box, mapping) : { ...ZERO_BOX },
  }));
  const base = fileName.replace(/\.[^.]+$/, "") || "scan";
  return {
    midiData: result.midi,
    fileName: `${base}-omr.mid`,
    warnings: [
      ...result.warnings,
      `Transcribed with the homr music-recognition model (${result.layoutSource}, ${result.staffCount} staff${result.staffCount === 1 ? "" : "s"}).`,
    ],
    imageWidth: mapping?.srcWidth ?? photoWidth,
    imageHeight: mapping?.srcHeight ?? photoHeight,
    noteLayout,
  };
}

let workerPromise: Promise<Worker> | null = null;

function ensureOmrWorker(onProgress?: (stage: string) => void): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = new Worker(new URL("../omr-homr-web/src/worker.ts", import.meta.url), {
        type: "module",
      });
      const urls = omrModelUrls();
      const ready = new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error("OMR worker load timed out")), 120_000);
        worker.onmessage = (event: MessageEvent) => {
          const msg = event.data as OmrWorkerMessage;
          if (msg.type === "ready") {
            window.clearTimeout(timer);
            resolve();
          } else if (msg.type === "error") {
            window.clearTimeout(timer);
            reject(new Error(msg.message));
          } else if (msg.type === "progress") {
            onProgress?.(msg.stage);
          }
        };
        worker.onerror = (event) => {
          window.clearTimeout(timer);
          reject(new Error(`OMR worker error: ${event.message || "unknown"}`));
        };
      });
      worker.postMessage({
        type: "load",
        encoderUrl: urls.encoderUrl,
        decoderUrl: urls.decoderUrl,
        segnetUrl: urls.segnetUrl,
        wasmPaths: ORT_WASM_CDN,
      });
      await ready;
      return worker;
    })();
    // Don't cache a broken worker; a later scan retries from scratch.
    workerPromise.catch(() => {
      workerPromise = null;
    });
  }
  return workerPromise;
}

async function fileToRgba(file: File): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2D canvas is not available");
    ctx.drawImage(bitmap, 0, 0);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data: img.data, width: canvas.width, height: canvas.height };
  } finally {
    bitmap.close();
  }
}

function requestTranscription(
  worker: Worker,
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  title: string,
  onProgress?: (stage: string) => void,
): Promise<OmrPageResult> {
  return new Promise<OmrPageResult>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      worker.onmessage = null;
      reject(new Error("Music recognition timed out"));
    }, TRANSCRIBE_TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as OmrWorkerMessage;
      if (msg.type === "result") {
        window.clearTimeout(timer);
        worker.onmessage = null;
        resolve(msg);
      } else if (msg.type === "error") {
        window.clearTimeout(timer);
        worker.onmessage = null;
        reject(new Error(msg.message));
      } else if (msg.type === "progress") {
        onProgress?.(msg.stage);
      }
    };
    const buffer = pixels.buffer as ArrayBuffer;
    worker.postMessage(
      { type: "transcribe-page", pixels: buffer, width, height, format: "rgba", title },
      [buffer],
    );
  });
}

/**
 * Transcribe a sheet-music photo with the omr-homr-web Worker.
 * Throws when the models are unreachable or transcription fails; callers
 * fall back to the built-in OCR reader.
 */
export async function transcribePhotoWithOmr(
  file: File,
  onProgress?: (stage: string) => void,
): Promise<ParsedSheetMusicWithLayout> {
  if (!(await isOmrModelAvailable())) {
    throw new Error("OMR models are not available");
  }
  const { data, width, height } = await fileToRgba(file);
  const worker = await ensureOmrWorker(onProgress);
  const result = await requestTranscription(worker, data, width, height, file.name, onProgress);
  return omrResultToScanResult(file.name, width, height, result);
}
