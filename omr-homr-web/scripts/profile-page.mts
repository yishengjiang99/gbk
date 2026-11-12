// Stage timing for the page pipeline (WASM/Node). Usage: node --import tsx/esm scripts/profile-page.mts <png> [threads]
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import * as ort from "onnxruntime-web";
import { wrap } from "../src/models.js";
import { preprocessPageImage, extractPagePredictions, detectStaffsInImage, transcribePage, defaultStaffTranscriber } from "../src/page.js";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const png = PNG.sync.read(readFileSync(process.argv[2]));
const threads = Number(process.argv[3] ?? 4);
ort.env.wasm.wasmPaths = join(pkg, "node_modules/onnxruntime-web/dist") + "/";
ort.env.wasm.numThreads = threads;
const t = (label: string, t0: number) => console.log(label.padEnd(22), (performance.now() - t0).toFixed(0), "ms");
let t0 = performance.now();
const mk = async (f: string) => wrap(await ort.InferenceSession.create(join(pkg, "models", f), { executionProviders: ["wasm"] }));
const encoder = await mk("transformer_encoder_model_fp32.onnx");
const decoder = await mk("transformer_decoder_model_fp32.onnx");
const segnet = await mk("segnet_model_fp16.onnx").catch((e) => { console.log("segnet fp16 wasm fail", e.message); return null; });
t("load sessions", t0);
console.log("page", png.width, "x", png.height, "threads", threads);
t0 = performance.now();
const page = preprocessPageImage(new Uint8Array(png.data), png.width, png.height, "rgba");
t("preprocess", t0);
if (!segnet) process.exit(0);
t0 = performance.now();
const masks = await extractPagePredictions(segnet, page.preprocessed, undefined, true);
t("segnet+filter", t0);
t0 = performance.now();
const det = detectStaffsInImage(masks, page.preprocessed);
t("staff detect", t0);
let enc = 0, dec = 0, steps = 0, prep = 0;
const timed = async (e: any, d: any, crop: any) => {
  const { preprocessStaff, encodeStaff, decodeStaff } = await import("../src/transformer.js");
  let a = performance.now();
  const ctx = await encodeStaff(e, preprocessStaff(crop.data, crop.width, crop.height));
  enc += performance.now() - a; a = performance.now();
  const syms = await decodeStaff(d, ctx);
  dec += performance.now() - a; steps += syms.length + 1;
  return syms;
};
t0 = performance.now();
const res = await transcribePage(masks, page.preprocessed, encoder, decoder, timed);
t("transcribePage total", t0);
console.log("staffs", res.staffCount, "encoder", enc.toFixed(0), "ms; decoder", dec.toFixed(0), "ms over", steps, "steps =", (dec / steps).toFixed(1), "ms/step");
if (process.env.OUT) {
  const { createHash } = await import("node:crypto");
  const { writeFileSync } = await import("node:fs");
  const h = createHash("sha256");
  for (const k of Object.keys(masks).sort()) h.update((masks as any)[k].data);
  writeFileSync(process.env.OUT, JSON.stringify({
    masks: h.digest("hex"),
    staffs: det.staffs.map((s: any) => [s.rect, s.minX, s.maxX, s.minY, s.maxY]),
    voices: res.voices.map((v) => v.symbols),
  }, null, 1));
}
