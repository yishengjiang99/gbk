/*
 * onnxruntime-web session creation for the homr worker.
 * Browser-only. Part of omr-homr-web, licensed under AGPL-3.0-only.
 *
 * Placement (validated in Phase 0 against ORT's WebGPU operator table):
 * - SegNet fp16 + encoder fp16 -> WebGPU when available, else WASM.
 * - Decoder fp32 (dynamically quantized) -> WASM only. Its
 *   com.microsoft::MultiHeadAttention nodes use past/present KV cache, which
 *   the WebGPU EP does not implement.
 */
import * as ort from "onnxruntime-web";
import type { SessionLike, TensorLike } from "./transformer.js";

export interface ModelSet {
  encoder: SessionLike;
  decoder: SessionLike;
  segnet?: SessionLike;
  /** True when the encoder build expects float16 input (the fp16 model file). */
  encoderInputFloat16?: boolean;
  /** True when the SegNet build expects float16 I/O (the fp16 model file). */
  segnetInputFloat16?: boolean;
}

function toTensorLike(t: ort.Tensor): TensorLike {
  const dims = [...t.dims];
  switch (t.type) {
    case "float32":
      return { dims, float32Data: t.data as Float32Array };
    case "float16":
      return { dims, float16Data: t.data as Uint16Array };
    case "int64":
      return { dims, int64Data: t.data as BigInt64Array };
    default:
      throw new Error(`unsupported tensor type ${t.type}`);
  }
}

function fromTensorLike(t: TensorLike, name: string): ort.Tensor {
  if (t.float32Data) {
    const data = t.float32Data instanceof Float32Array ? t.float32Data : Float32Array.from(t.float32Data);
    return new ort.Tensor("float32", data, t.dims);
  }
  if (t.float16Data) return new ort.Tensor("float16", t.float16Data, t.dims);
  if (t.int64Data) return new ort.Tensor("int64", t.int64Data, t.dims);
  throw new Error(`no tensor data for feed "${name}"`);
}

export function wrap(session: ort.InferenceSession): SessionLike {
  return {
    async run(feeds: Record<string, TensorLike>): Promise<Record<string, TensorLike>> {
      const ortFeeds: Record<string, ort.Tensor> = {};
      for (const [name, tensor] of Object.entries(feeds)) ortFeeds[name] = fromTensorLike(tensor, name);
      const outputs = await session.run(ortFeeds);
      const result: Record<string, TensorLike> = {};
      for (const [name, tensor] of Object.entries(outputs)) result[name] = toTensorLike(tensor);
      return result;
    },
  };
}

/** Release tag of the homr weights; bump to invalidate the model cache. */
export const MODELS_VERSION = "onnx_checkpoints";
const CACHE_NAME = `omr-homr-web-models-${MODELS_VERSION}`;

function versionedUrl(url: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${MODELS_VERSION}`;
}

/**
 * Cache-first model fetch through the Cache API. onnxruntime-web fetches the
 * weight URL itself, but it cannot see the Cache API, so we materialize the
 * bytes here and hand ORT an ArrayBuffer (it accepts that directly).
 */
async function fetchModelBytes(url: string, onProgress?: (stage: string) => void): Promise<ArrayBuffer> {
  const cache = await caches.open(CACHE_NAME);
  const key = versionedUrl(url);
  const hit = await cache.match(key);
  if (hit) {
    onProgress?.(`model cache hit: ${url.split("/").pop()}`);
    return hit.arrayBuffer();
  }
  onProgress?.(`downloading model: ${url.split("/").pop()}`);
  const response = await fetch(key);
  if (!response.ok) throw new Error(`model download failed: ${response.status} ${url}`);
  await cache.put(key, response.clone());
  return response.arrayBuffer();
}

async function createSession(
  url: string,
  executionProviders: string[],
  onProgress?: (stage: string) => void,
): Promise<SessionLike> {
  const bytes = await fetchModelBytes(url, onProgress);
  const session = await ort.InferenceSession.create(bytes, { executionProviders });
  return wrap(session);
}

/** Override where onnxruntime-web loads its .wasm/.mjs runtime files from. */
export function setWasmPaths(paths: string): void {
  ort.env.wasm.wasmPaths = paths;
}

/** True when the WebGPU EP can be used (Chrome/Edge 113+, not Safari/Firefox). */
export function webGpuAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

export interface ModelUrls {
  encoderUrl: string;
  decoderUrl: string;
  segnetUrl?: string;
}

export async function loadModels(
  urls: ModelUrls,
  onProgress?: (stage: string) => void,
  opts?: { strictWebGpu?: boolean; wasmOnly?: boolean },
): Promise<ModelSet> {
  // Multithreaded WASM needs SharedArrayBuffer (COOP/COEP); GitHub Pages does
  // not send those headers, so fall back to a single thread there.
  const threads =
    typeof crossOriginIsolated !== "undefined" && crossOriginIsolated
      ? Math.min(4, (typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 4) || 4)
      : 1;
  ort.env.wasm.numThreads = threads;
  ort.env.wasm.simd = true;

  const gpu = webGpuAvailable();
  // strictWebGpu (demo/diagnostics): ["webgpu"] with no wasm fallback, so a
  // missing/broken WebGPU fails loudly instead of silently benchmarking wasm.
  // wasmOnly (GPU-less CI/VMs): skip WebGPU entirely — SwiftShader has no
  // shader-f16 (fp16 WGSL fails to compile) and the fp32 encoder stalls there.
  const gpuFirst = opts?.wasmOnly
    ? ["wasm"]
    : !gpu
      ? ["wasm"]
      : opts?.strictWebGpu
        ? ["webgpu"]
        : ["webgpu", "wasm"];
  // Create sessions sequentially: onnxruntime-web's wasm backend throws
  // "multiple calls to 'initWasm()' detected" when two sessions initialize
  // the wasm runtime concurrently (e.g. a webgpu->wasm fallback racing the
  // decoder's wasm-only session).
  const encoder = await createSession(urls.encoderUrl, gpuFirst, onProgress);
  const decoder = await createSession(urls.decoderUrl, ["wasm"], onProgress);
  const segnet = urls.segnetUrl
    ? await createSession(urls.segnetUrl, gpuFirst, onProgress)
    : undefined;
  return {
    encoder,
    decoder,
    segnet,
    encoderInputFloat16: urls.encoderUrl.includes("fp16"),
    segnetInputFloat16: urls.segnetUrl?.includes("fp16") ?? false,
  };
}
