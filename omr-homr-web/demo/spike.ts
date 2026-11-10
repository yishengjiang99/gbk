/* Web-scan feasibility spike (throwaway). ?img=<file in demo/spike-inputs>&engine=homr|builtin[&wasm=1]
 * Times model load + transcription in a real browser and exposes window.__spike. */
import { parseSheetMusicWithLayout } from "../../src/sheet-music-reader.ts";
const q = new URLSearchParams(location.search);
const img = q.get("img")!; const engine = q.get("engine") ?? "homr"; const forceWasm = q.get("wasm") === "1";
const logEl = document.getElementById("log")!;
const t0 = performance.now(); const stages: Array<[number, string]> = [];
const log = (s: string) => { const t = Math.round(performance.now() - t0); stages.push([t, s]); logEl.textContent += `${t}ms ${s}\n`; };
const b64 = (b: ArrayBuffer) => { let s = ""; const u = new Uint8Array(b); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
const done = (r: unknown) => { (window as any).__spike = r; };
async function main() {
  const blob = await (await fetch(`/demo/spike-inputs/${img}`)).blob();
  const file = new File([blob], img, { type: img.endsWith(".png") ? "image/png" : "image/jpeg" });
  if (engine === "builtin") {
    const ts = performance.now(); const r = await parseSheetMusicWithLayout(file);
    return done({ engine, img, transcribeMs: Math.round(performance.now() - ts), notes: r.noteLayout.map((n) => [n.pitch, n.startSec, n.endSec]), warnings: r.warnings, midi: b64(r.midiData) });
  }
  let shaderF16 = false;
  if ("gpu" in navigator) { try { shaderF16 = !!(await (navigator as any).gpu.requestAdapter())?.features.has("shader-f16"); } catch { /* none */ } }
  const encoderUrl = shaderF16 && !forceWasm ? "/models/transformer_encoder_model_fp16.onnx" : "/models/transformer_encoder_model_fp32.onnx";
  const worker = new Worker("/demo/dist/worker.bundle.js");
  const tl = performance.now();
  await new Promise<void>((res, rej) => { worker.onmessage = (e) => { const m = e.data; if (m.type === "ready") res(); else if (m.type === "progress") log(m.stage); else if (m.type === "error") rej(new Error(m.message)); }; worker.onerror = (e) => rej(new Error(e.message));
    worker.postMessage({ type: "load", encoderUrl, decoderUrl: "/models/transformer_decoder_model_fp32.onnx", segnetUrl: "/models/segnet_model_fp16.onnx", wasmPaths: "/node_modules/onnxruntime-web/dist/", strictWebGpu: shaderF16 && !forceWasm, wasmOnly: forceWasm }); });
  const loadMs = Math.round(performance.now() - tl);
  const bmp = await createImageBitmap(blob); const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext("2d")!; ctx.drawImage(bmp, 0, 0); const px = ctx.getImageData(0, 0, c.width, c.height);
  const ts = performance.now();
  const r: any = await new Promise((res, rej) => { worker.onmessage = (e) => { const m = e.data; if (m.type === "result") res(m); else if (m.type === "progress") log(m.stage); else if (m.type === "error") rej(new Error(m.message)); };
    const buf = px.data.buffer as ArrayBuffer; worker.postMessage({ type: "transcribe-page", pixels: buf, width: c.width, height: c.height, format: "rgba", title: img }, [buf]); });
  done({ engine, img, shaderF16, forceWasm, loadMs, transcribeMs: Math.round(performance.now() - ts), staffCount: r.staffCount, warnings: r.warnings, diagnostics: r.diagnostics, notes: r.noteLayout.map((n: any) => [n.pitch, n.startSec, n.endSec]), midi: b64(r.midi), symbols: r.symbols, grandstaff: r.grandstaff, stages });
}
main().catch((e) => done({ engine, img, error: String(e), stages }));
