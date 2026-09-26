/**
 * SegNet segmentation: TypeScript port of homr's
 * segmentation/inference_segnet.py.
 *
 * The page is processed in 320x320 tiles (step 320 by default, matching
 * homr's extract() call; smaller steps give overlapping tiles which are
 * averaged on stitch). Each tile is fed to the SegNet ONNX model as raw
 * 0..255 BGR float (the grayscale page copied into three channels, no
 * normalisation). The per-pixel argmax over the six classes is stitched
 * back, and overlapping regions are averaged exactly like the Python
 * merge_patches (mean of the integer class ids, truncated to int).
 *
 * Class ids: 0 background, 1 stems/rests, 2 noteheads, 3 clefs/keys,
 * 4 staff lines, 5 other symbols.
 */

import { GrayImage } from "./image.ts";
import { SessionLike, TensorLike, float16ToFloat32, float32ToFloat16 } from "../transformer.ts";

export const SEGNET_WINDOW = 320;
export const SEGNET_STEP = 320;
export const SEGNET_BATCH = 8;
export const SEGNET_CLASSES = 6;

export interface SegNetMasks {
  /** Class 4: staff lines. */
  staff: GrayImage;
  /** Class 5: other symbols. */
  symbols: GrayImage;
  /** Class 1: stems and rests. */
  stemsRest: GrayImage;
  /** Class 2: noteheads. */
  notehead: GrayImage;
  /** Class 3: clefs and key signatures. */
  clefsKeys: GrayImage;
}

export interface SegNetTile {
  /** BGR float32 tile, [3, 320, 320] flattened, raw 0..255 values. */
  data: Float32Array;
  /** Top-left (x, y) of the tile in the page. */
  x: number;
  y: number;
}

/**
 * Split the grayscale page into 320x320 tiles. Out-of-bounds regions are
 * padded white (255), matching homr's extract().
 */
export function extractTiles(
  image: GrayImage,
  stepSize = SEGNET_STEP,
  windowSize = SEGNET_WINDOW,
): SegNetTile[] {
  const h = image.height;
  const w = image.width;
  const tiles: SegNetTile[] = [];
  for (let loopY = 0; loopY < Math.max(h, windowSize); loopY += stepSize) {
    for (let loopX = 0; loopX < Math.max(w, windowSize); loopX += stepSize) {
      const y = Math.min(loopY, h - windowSize);
      const x = Math.min(loopX, w - windowSize);
      const data = new Float32Array(3 * windowSize * windowSize);
      for (let ty = 0; ty < windowSize; ty++) {
        const sy = y + ty;
        for (let tx = 0; tx < windowSize; tx++) {
          const sx = x + tx;
          const v = sy < 0 || sy >= h || sx < 0 || sx >= w ? 255 : image.data[sy * w + sx];
          const o = ty * windowSize + tx;
          data[o] = v;
          data[windowSize * windowSize + o] = v;
          data[2 * windowSize * windowSize + o] = v;
        }
      }
      tiles.push({ data, x, y });
    }
  }
  return tiles;
}

function argmaxClasses(output: Float32Array, batch: number, hw: number): Int32Array[] {
  const patches: Int32Array[] = [];
  for (let n = 0; n < batch; n++) {
    const patch = new Int32Array(hw);
    const base = n * SEGNET_CLASSES * hw;
    for (let i = 0; i < hw; i++) {
      let best = 0;
      let bestV = -Infinity;
      for (let c = 0; c < SEGNET_CLASSES; c++) {
        const v = output[base + c * hw + i];
        if (v > bestV) {
          bestV = v;
          best = c;
        }
      }
      patch[i] = best;
    }
    patches.push(patch);
  }
  return patches;
}

/**
 * Stitch integer class-id patches back to a full-page label map.
 * Overlapping tiles are averaged and truncated to int, exactly like
 * homr's merge_patches ((merged / counter).astype(int)).
 */
export function mergePatches(
  patches: Int32Array[],
  tiles: SegNetTile[],
  width: number,
  height: number,
  windowSize = SEGNET_WINDOW,
): Int32Array {
  const merged = new Float64Array(width * height);
  const counter = new Float64Array(width * height);
  for (let t = 0; t < patches.length; t++) {
    const patch = patches[t];
    const { x: ox, y: oy } = tiles[t];
    for (let ty = 0; ty < windowSize; ty++) {
      const sy = oy + ty;
      if (sy < 0 || sy >= height) continue;
      for (let tx = 0; tx < windowSize; tx++) {
        const sx = ox + tx;
        if (sx < 0 || sx >= width) continue;
        const i = sy * width + sx;
        merged[i] += patch[ty * windowSize + tx];
        counter[i] += 1;
      }
    }
  }
  const labels = new Int32Array(width * height);
  for (let i = 0; i < labels.length; i++) {
    // numpy astype(int64) truncates toward zero; labels are non-negative.
    labels[i] = counter[i] > 0 ? Math.floor(merged[i] / counter[i]) : 0;
  }
  return labels;
}

function maskFromLabels(labels: Int32Array, width: number, height: number, cls: number): GrayImage {
  const img = GrayImage.zeros(width, height);
  for (let i = 0; i < labels.length; i++) img.data[i] = labels[i] === cls ? 1 : 0;
  return img;
}

export function masksFromLabels(labels: Int32Array, width: number, height: number): SegNetMasks {
  return {
    staff: maskFromLabels(labels, width, height, 4),
    symbols: maskFromLabels(labels, width, height, 5),
    stemsRest: maskFromLabels(labels, width, height, 1),
    notehead: maskFromLabels(labels, width, height, 2),
    clefsKeys: maskFromLabels(labels, width, height, 3),
  };
}

export interface SegNetRunOptions {
  stepSize?: number;
  windowSize?: number;
  batchSize?: number;
  /** True when the ONNX model expects float16 I/O (the fp16 WebGPU build). */
  inputFloat16?: boolean;
  inputName?: string;
  outputName?: string;
  onProgress?: (done: number, total: number) => void;
}

function tensorInput(data: Float32Array, inputFloat16: boolean): TensorLike {
  if (inputFloat16) {
    return { dims: [data.length / (3 * SEGNET_WINDOW * SEGNET_WINDOW), 3, SEGNET_WINDOW, SEGNET_WINDOW], float16Data: float32ToFloat16(data) };
  }
  return { dims: [data.length / (3 * SEGNET_WINDOW * SEGNET_WINDOW), 3, SEGNET_WINDOW, SEGNET_WINDOW], float32Data: data };
}

/**
 * Run tiled SegNet inference over a grayscale page and return the six-class
 * label map (Int32Array of class ids, row-major).
 */
export async function runSegNet(
  session: SessionLike,
  image: GrayImage,
  opts: SegNetRunOptions = {},
): Promise<Int32Array> {
  const {
    stepSize = SEGNET_STEP,
    windowSize = SEGNET_WINDOW,
    batchSize = SEGNET_BATCH,
    inputFloat16 = false,
    inputName = "input",
    outputName = "output",
    onProgress,
  } = opts;
  const tiles = extractTiles(image, stepSize, windowSize);
  const patches: Int32Array[] = [];
  const hw = windowSize * windowSize;
  for (let b = 0; b < tiles.length; b += batchSize) {
    const group = tiles.slice(b, b + batchSize);
    const n = group.length;
    const batchData = new Float32Array(n * 3 * hw);
    for (let i = 0; i < n; i++) batchData.set(group[i].data, i * 3 * hw);
    const outputs = await session.run({ [inputName]: tensorInput(batchData, inputFloat16) });
    const out = outputs[outputName];
    let logits: Float32Array;
    if (out.float32Data) {
      logits = out.float32Data instanceof Float32Array ? out.float32Data : Float32Array.from(out.float32Data);
    } else if (out.float16Data) {
      logits = float16ToFloat32(out.float16Data);
    } else {
      throw new Error("segnet output has no float data");
    }
    patches.push(...argmaxClasses(logits, n, hw));
    onProgress?.(Math.min(b + batchSize, tiles.length), tiles.length);
  }
  return mergePatches(patches, tiles, image.width, image.height, windowSize);
}

/** Convenience: run SegNet and split the label map into the five masks. */
export async function predictMasks(
  session: SessionLike,
  image: GrayImage,
  opts: SegNetRunOptions = {},
): Promise<SegNetMasks> {
  const labels = await runSegNet(session, image, opts);
  return masksFromLabels(labels, image.width, image.height);
}
