/*
 * Phase 2 gate: the JS decode loop must reproduce the Python oracle token
 * sequence on the C-scale staff. Uses onnxruntime-web's wasm EP in Node with
 * the fp32 encoder (wasm cannot run fp16); the fp16->fp32 cast path is covered
 * by unit tests and the real fp16 encoder runs on WebGPU in the browser demo.
 * Skips when models are absent (npm run fetch:models).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-web";
import { wrap } from "../src/models.js";
import {
  decodeStaff,
  encodeStaff,
  float16ToFloat32,
  preprocessStaff,
  transcribeStaff,
} from "../src/transformer.js";

const root = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(root, "fixtures", name);
const modelPath = (name: string) => join(root, "..", "models", name);

describe("fp16 -> fp32 cast", () => {
  it("converts known half values", () => {
    const out = float16ToFloat32(new Uint16Array([0x3c00, 0x4000, 0xbc00, 0xc000, 0x0000, 0x8000, 0x7c00]));
    assert.equal(out[0], 1);
    assert.equal(out[1], 2);
    assert.equal(out[2], -1);
    assert.equal(out[3], -2);
    assert.equal(out[4], 0);
    assert.ok(Object.is(out[5], -0));
    assert.equal(out[6], Infinity);
  });

  it("converts a subnormal half", () => {
    const out = float16ToFloat32(new Uint16Array([0x0001]));
    assert.ok(Math.abs(out[0] - 2 ** -24) < 1e-12, `got ${out[0]}`);
  });

  it("round-trips through the encoder scale", () => {
    // 0.7931 in fp16 is 0x3a5b-ish; just check monotonic sane behavior.
    const out = float16ToFloat32(new Uint16Array([0x3a5b]));
    assert.ok(out[0] > 0.79 && out[0] < 0.8, `got ${out[0]}`);
  });
});

describe("staff preprocessing", () => {
  it("normalizes with homr's mean/std", () => {
    const px = new Uint8Array([0, 255, 128, 64]);
    // 2x2 fake dims are rejected; use the real dims with padding.
    const big = new Uint8Array(1280 * 256);
    big.set(px);
    const out = preprocessStaff(big, 1280, 256);
    assert.equal(out.length, 1280 * 256);
    assert.ok(Math.abs(out[0] - (0 / 255 - 0.7931) / 0.1738) < 1e-6);
    assert.ok(Math.abs(out[1] - (1 - 0.7931) / 0.1738) < 1e-6);
  });

  it("rejects wrong dimensions", () => {
    assert.throws(() => preprocessStaff(new Uint8Array(100 * 100), 100, 100), /1280x2560|1280x256/);
  });
});

const ENCODER = modelPath("transformer_encoder_model_fp32.onnx");
const DECODER = modelPath("transformer_decoder_model_fp32.onnx");
const modelsPresent = existsSync(ENCODER) && existsSync(DECODER);

describe("decode loop vs Python oracle (C-scale staff)", { skip: !modelsPresent }, () => {
  it("reproduces the 21-symbol oracle sequence", async () => {
    ort.env.wasm.wasmPaths = join(root, "..", "node_modules", "onnxruntime-web", "dist") + "/";
    ort.env.wasm.numThreads = 4;
    const encoder = wrap(await ort.InferenceSession.create(ENCODER, { executionProviders: ["wasm"] }));
    const decoder = wrap(await ort.InferenceSession.create(DECODER, { executionProviders: ["wasm"] }));

    const pixels = new Uint8Array(readFileSync(fixture("c-scale-staff-0.gray")).buffer);
    const symbols = await transcribeStaff(encoder, decoder, pixels, 1280, 256);

    const oracle = JSON.parse(readFileSync(fixture("c-scale-raw-tokens.json"), "utf8"));
    assert.equal(symbols.length, oracle.length, `symbol count ${symbols.length} != ${oracle.length}`);
    for (let i = 0; i < oracle.length; i += 1) {
      for (const field of ["rhythm", "pitch", "lift", "articulation", "slur", "position"] as const) {
        assert.equal(
          symbols[i][field],
          oracle[i][field],
          `symbol ${i} field ${field}: ${symbols[i][field]} != ${oracle[i][field]}`,
        );
      }
    }
  });

  it("encodeStaff returns a [1,1280,512] fp32 context", async () => {
    ort.env.wasm.wasmPaths = join(root, "..", "node_modules", "onnxruntime-web", "dist") + "/";
    const encoder = wrap(await ort.InferenceSession.create(ENCODER, { executionProviders: ["wasm"] }));
    const pixels = new Uint8Array(readFileSync(fixture("c-scale-staff-0.gray")).buffer);
    const input = preprocessStaff(pixels, 1280, 256);
    const ctx = await encodeStaff(encoder, input);
    assert.deepEqual([...ctx.dims], [1, 1280, 512]);
    assert.equal(ctx.data.length, 1 * 1280 * 512);
  });
});
