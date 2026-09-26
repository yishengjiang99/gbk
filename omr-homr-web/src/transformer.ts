/*
 * EP-agnostic transformer inference: homr encoder + host-driven decoder loop.
 * Direct port of homr/homr/transformer/staff2score.py and
 * homr/homr/transformer/decoder_inference.py. Part of omr-homr-web,
 * licensed under AGPL-3.0-only. See NOTICE for attribution.
 *
 * This module never imports an ONNX Runtime package. The caller supplies
 * sessions through the SessionLike interface (onnxruntime-web in the worker,
 * onnxruntime-node in tests), so the decode logic is identical everywhere.
 */
import {
  ARTICULATION_TOKENS,
  BOS_TOKEN,
  DECODER_DIM,
  DECODER_HEADS,
  DECODER_KV_LAYERS,
  DecodedSymbol,
  ENCODER_MEAN,
  ENCODER_STD,
  EOS_TOKEN,
  LIFT_TOKENS,
  MAX_SEQ_LEN,
  NONOTE_TOKEN,
  PITCH_TOKENS,
  POSITION_TOKENS,
  RHYTHM_TOKENS,
  SLUR_TOKENS,
} from "./vocab.js";

/** Minimal tensor view. Backends adapt their native tensor to this shape. */
export interface TensorLike {
  readonly dims: readonly number[];
  readonly float32Data?: Float32Array | number[];
  readonly float16Data?: Uint16Array;
  readonly int64Data?: BigInt64Array;
}

export interface SessionLike {
  run(feeds: Record<string, TensorLike>): Promise<Record<string, TensorLike>>;
}

export const ENCODER_INPUT_NAME = "input";
export const ENCODER_OUTPUT_NAME = "output";
export const ENCODER_WIDTH = 1280;
export const ENCODER_HEIGHT = 256;

/**
 * Preprocess one dewarped staff crop for the encoder: grayscale [H,W] uint8
 * in [0,255] -> normalized float32 [1,1,H,W], matching homr's ConvertToArray
 * (divide by 255, then (x - 0.7931) / 0.1738).
 */
export function preprocessStaff(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number): Float32Array {
  if (width !== ENCODER_WIDTH || height !== ENCODER_HEIGHT) {
    throw new Error(`encoder expects ${ENCODER_WIDTH}x${ENCODER_HEIGHT}, got ${width}x${height}`);
  }
  if (pixels.length < width * height) throw new Error("pixel buffer too small");
  const out = new Float32Array(1 * 1 * height * width);
  for (let i = 0; i < width * height; i += 1) {
    out[i] = (pixels[i] / 255 - ENCODER_MEAN) / ENCODER_STD;
  }
  return out;
}

/** IEEE-754 binary16 -> float32, for the fp16 encoder context before decode. */
export function float16ToFloat32(src: Uint16Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 1) {
    const h = src[i];
    const sign = (h & 0x8000) << 16;
    const exp = (h >> 10) & 0x1f;
    const mant = h & 0x03ff;
    let bits: number;
    if (exp === 0) {
      if (mant === 0) {
        bits = sign;
      } else {
        // Subnormal: renormalize into a normal float32.
        let m = mant;
        let e = -14;
        while ((m & 0x0400) === 0) {
          m <<= 1;
          e -= 1;
        }
        m &= 0x03ff;
        bits = sign | ((e + 127) << 23) | (m << 13);
      }
    } else if (exp === 31) {
      bits = sign | 0x7f800000 | (mant << 13); // inf / NaN
    } else {
      bits = sign | ((exp + 112) << 23) | (mant << 13);
    }
    out[i] = bitsToFloat(bits);
  }
  return out;
}

const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
function bitsToFloat(bits: number): number {
  _u32[0] = bits;
  return _f32[0];
}

function floatToBits(v: number): number {
  _f32[0] = v;
  return _u32[0];
}

/** float32 -> IEEE-754 binary16 bits, for feeding fp16 models. */
export function float32ToFloat16(src: Float32Array | number[]): Uint16Array {
  const out = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i += 1) {
    const bits = floatToBits(src[i]);
    const sign = (bits >> 16) & 0x8000;
    const exp = ((bits >> 23) & 0xff) - 112;
    const mant = bits & 0x007fffff;
    let h: number;
    if (exp >= 31) {
      h = sign | 0x7bff; // overflow -> inf (matches round-to-nearest clamping)
    } else if (exp <= 0) {
      h = sign; // underflow -> zero (subnormals flush to zero; inputs are 0..255)
    } else {
      h = sign | (exp << 10) | (mant >> 13);
    }
    out[i] = h;
  }
  return out;
}

function asFloat32(t: TensorLike): Float32Array {
  if (t.float32Data) return t.float32Data instanceof Float32Array ? t.float32Data : Float32Array.from(t.float32Data);
  if (t.float16Data) return float16ToFloat32(t.float16Data);
  throw new Error("tensor has no float data");
}

function argmaxLastDim(logits: Float32Array | number[]): number {
  let best = 0;
  let bestVal = -Infinity;
  for (let i = 0; i < logits.length; i += 1) {
    const v = logits[i];
    if (v > bestVal) {
      bestVal = v;
      best = i;
    }
  }
  return best;
}

function int64Scalar(value: number): TensorLike {
  return { dims: [1, 1], int64Data: BigInt64Array.from([BigInt(value)]) };
}

function kvCacheName(i: number, dir: "in" | "out"): string {
  return dir === "in" ? `cache_in${i}` : `cache_out${i}`;
}

export interface EncoderContext {
  readonly data: Float32Array;
  readonly dims: readonly number[];
}

/** Run the encoder once per staff. Returns the fp32 context for the decoder. */
export async function encodeStaff(
  session: SessionLike,
  input: Float32Array,
  inputFloat16 = false,
): Promise<EncoderContext> {
  const outputs = await session.run({
    [ENCODER_INPUT_NAME]: inputFloat16
      ? { dims: [1, 1, ENCODER_HEIGHT, ENCODER_WIDTH], float16Data: float32ToFloat16(input) }
      : { dims: [1, 1, ENCODER_HEIGHT, ENCODER_WIDTH], float32Data: input },
  });
  const raw = outputs[ENCODER_OUTPUT_NAME];
  if (!raw) throw new Error("encoder output missing");
  return { data: asFloat32(raw), dims: raw.dims };
}

const HEAD_NAMES = ["rhythms", "pitchs", "lifts", "articulations", "slurs"] as const;
const HEAD_VOCABS = [RHYTHM_TOKENS, PITCH_TOKENS, LIFT_TOKENS, ARTICULATION_TOKENS, SLUR_TOKENS] as const;

/**
 * Host-driven autoregressive decode loop. Mirrors ScoreDecoder.generate():
 * each step feeds the last token of the five input streams, the encoder
 * context (full on step 0, first slice afterwards), cache_len=[step], and the
 * 32 KV caches; takes greedy argmax over the six heads; stops when the rhythm
 * head predicts EOS or MAX_SEQ_LEN steps are reached.
 */
export async function decodeStaff(session: SessionLike, context: EncoderContext): Promise<DecodedSymbol[]> {
  const symbols: DecodedSymbol[] = [];
  const lastIds = [BOS_TOKEN, NONOTE_TOKEN, NONOTE_TOKEN, NONOTE_TOKEN, NONOTE_TOKEN];
  let caches: Float32Array[] = Array.from({ length: DECODER_KV_LAYERS }, () => new Float32Array(0));
  const contextLen = context.dims[1];
  const contextStep = context.data.length / contextLen; // floats per context row (512)

  for (let step = 0; step < MAX_SEQ_LEN; step += 1) {
    const feeds: Record<string, TensorLike> = {};
    for (let h = 0; h < HEAD_NAMES.length; h += 1) {
      feeds[HEAD_NAMES[h]] = int64Scalar(lastIds[h]);
    }
    // homr: full context on step 0, context[:, :1] afterwards.
    const ctxData = step === 0 ? context.data : context.data.slice(0, contextStep);
    feeds["context"] = { dims: [1, step === 0 ? contextLen : 1, DECODER_DIM], float32Data: ctxData };
    feeds["cache_len"] = { dims: [1], int64Data: BigInt64Array.from([BigInt(step)]) };
    for (let i = 0; i < DECODER_KV_LAYERS; i += 1) {
      feeds[kvCacheName(i, "in")] = {
        dims: [1, DECODER_HEADS, caches[i].length / (DECODER_HEADS * (DECODER_DIM / DECODER_HEADS)), DECODER_DIM / DECODER_HEADS],
        float32Data: caches[i],
      };
    }

    const outputs = await session.run(feeds);

    const ids: number[] = [];
    for (let h = 0; h < HEAD_NAMES.length; h += 1) {
      const logits = asFloat32(outputs[`out_${HEAD_NAMES[h]}`]);
      ids.push(argmaxLastDim(logits));
    }
    const positionId = argmaxLastDim(asFloat32(outputs["out_positions"]));
    const attention = asFloat32(outputs["attention"]);

    if (ids[0] === EOS_TOKEN) break;

    symbols.push({
      rhythm: RHYTHM_TOKENS[ids[0]] ?? `<?>`,
      pitch: PITCH_TOKENS[ids[1]] ?? `<?>`,
      lift: LIFT_TOKENS[ids[2]] ?? `<?>`,
      articulation: ARTICULATION_TOKENS[ids[3]] ?? `<?>`,
      slur: SLUR_TOKENS[ids[4]] ?? `<?>`,
      position: POSITION_TOKENS[positionId] ?? `<?>`,
      attention: [attention[0] ?? 0, attention[1] ?? 0],
    });

    for (let h = 0; h < HEAD_NAMES.length; h += 1) lastIds[h] = ids[h];
    const nextCaches: Float32Array[] = [];
    for (let i = 0; i < DECODER_KV_LAYERS; i += 1) {
      nextCaches.push(asFloat32(outputs[kvCacheName(i, "out")]));
    }
    caches = nextCaches;
  }
  return symbols;
}

/** One-shot staff -> symbols, the Phase 2 demo path. */
export async function transcribeStaff(
  encoder: SessionLike,
  decoder: SessionLike,
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  encoderInputFloat16 = false,
): Promise<DecodedSymbol[]> {
  const input = preprocessStaff(pixels, width, height);
  const context = await encodeStaff(encoder, input, encoderInputFloat16);
  return decodeStaff(decoder, context);
}
