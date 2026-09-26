/* Browser page demo (isolated technical demo, not product UI).
 * Drives the real omr-homr-web Worker end-to-end in the browser:
 * load (fp16 encoder+SegNet on WebGPU when shader-f16 is present, else
 * fp32 encoder on WebGPU with WASM fallback for the fp16 SegNet) ->
 * transcribe-page on the C-scale page fixture -> score Layers A/B/C.
 */
const $ = (id: string) => document.getElementById(id)!;
const logEl = $("log");
const resultEl = $("result");

function log(msg: string): void {
  logEl.textContent += msg + "\n";
}

interface PageDemoResult {
  webgpu: boolean;
  shaderF16: boolean;
  encoder: string;
  staffCount: number;
  layerA: { exact: number; total: number; pass: boolean };
  layerB: { matched: number; total: number; pass: boolean };
  layerC: { entries: number; boxed: number; layoutSource: string; pass: boolean };
  midiBytes: number;
  midiFormatOk: boolean;
  warnings: string[];
  pass: boolean;
  error?: string;
}

const FIELDS = ["rhythm", "pitch", "lift", "articulation", "slur", "position"];

// Layer B oracle: C-major scale up and down, canonical (tick,pitch,duration,staff).
const WANT_NOTES: Array<[number, number, number, number]> = [
  [0, 64, 480, 0], [480, 65, 480, 0], [960, 67, 480, 0], [1440, 69, 480, 0],
  [1920, 71, 480, 0], [2400, 72, 480, 0], [2880, 74, 480, 0], [3360, 76, 480, 0],
  [3840, 74, 480, 0], [4320, 72, 480, 0], [4800, 71, 480, 0], [5280, 69, 480, 0],
  [5760, 67, 480, 0], [6240, 65, 480, 0], [6720, 64, 480, 0],
];

async function pagePixels(url: string): Promise<{ data: Uint8Array; width: number; height: number }> {
  const res = await fetch(url);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return { data: new Uint8Array(img.data.buffer.slice(img.data.byteOffset, img.data.byteOffset + img.data.byteLength)), width: bmp.width, height: bmp.height };
}

function checkMidi(bytes: Uint8Array): { formatOk: boolean; size: number } {
  const fmt = (bytes[8] << 8) | bytes[9];
  const division = (bytes[12] << 8) | bytes[13];
  const ok =
    bytes[0] === 0x4d && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64 &&
    fmt === 1 && division === 480;
  return { formatOk: ok, size: bytes.length };
}

interface LayoutEntry {
  pitch: number;
  startSec: number;
  endSec: number;
  box: { x: number; y: number; w: number; h: number } | null;
}

async function main(): Promise<void> {
  const done = (r: PageDemoResult) => {
    (window as unknown as { __demoResult: PageDemoResult }).__demoResult = r;
    resultEl.textContent = JSON.stringify(r, null, 2);
    log(r.pass ? "PAGE DEMO PASS" : `PAGE DEMO FAIL${r.error ? ": " + r.error : ""}`);
  };
  try {
    // fp16 compute needs the WGSL shader-f16 feature (absent on SwiftShader).
    // Without it, the fp16 SegNet (no fp32 build exists) runs on the WASM EP
    // via the non-strict load; the encoder still uses the fp32 WebGPU build.
    let shaderF16 = false;
    if ("gpu" in navigator) {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        shaderF16 = !!adapter?.features.has("shader-f16");
      } catch {
        shaderF16 = false;
      }
    }
    const webgpu = "gpu" in navigator;
    // ?wasm=1 forces the WASM execution provider for every model: SwiftShader
    // has no shader-f16 (fp16 WGSL fails to compile) and the fp32 transformer
    // encoder stalls on its WebGPU EP, so a full browser proof on a GPU-less
    // VM must bypass WebGPU entirely. Real-GPU browsers use the default path.
    const forceWasm = new URLSearchParams(location.search).get("wasm") === "1";
    const encoderUrl = shaderF16 && !forceWasm
      ? "/models/transformer_encoder_model_fp16.onnx"
      : "/models/transformer_encoder_model_fp32.onnx";
    log(`WebGPU ${webgpu ? "available" : "unavailable"}, shader-f16 ${shaderF16 ? "yes" : "no"}, forceWasm=${forceWasm} -> ${shaderF16 && !forceWasm ? "fp16" : "fp32"} encoder, fp16 SegNet`);

    const [page, oracle] = await Promise.all([
      pagePixels("/demo/fixtures/c-scale-page.png"),
      fetch("/test/fixtures/c-scale-raw-tokens.json").then((r) => r.json()) as Promise<Array<Record<string, string>>>,
    ]);
    log(`page fixture: ${page.width}x${page.height}, oracle: ${oracle.length} symbols`);

    const worker = new Worker("/demo/dist/worker.bundle.js");
    const encoderName = `${forceWasm ? "wasm-only" : shaderF16 ? "fp16" : "fp32"} encoder + fp16 SegNet`;
    const ready = new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("worker load timeout")), 180000);
      worker.onmessage = (ev: MessageEvent) => {
        const m = ev.data;
        if (m.type === "ready") {
          clearTimeout(timer);
          log(`worker ready, webgpu=${m.webgpu}`);
          resolve(m.webgpu);
        } else if (m.type === "progress") {
          log(`  ... ${m.stage}`);
        } else if (m.type === "error") {
          clearTimeout(timer);
          reject(new Error(m.message));
        }
      };
      worker.onerror = (e) => reject(new Error("worker error: " + e.message));
    });
    worker.postMessage({
      type: "load",
      encoderUrl,
      decoderUrl: "/models/transformer_decoder_model_fp32.onnx",
      segnetUrl: "/models/segnet_model_fp16.onnx",
      wasmPaths: "/node_modules/onnxruntime-web/dist/",
      // Strict WebGPU only when fp16 compute is actually available and WASM
      // was not forced; otherwise the fp16 SegNet must be allowed to fall
      // back to WASM (or WASM is used for everything).
      strictWebGpu: shaderF16 && !forceWasm,
      wasmOnly: forceWasm,
    });
    const workerWebGpu = await ready;

    const result = await new Promise<{
      symbols: Array<Array<Record<string, string>>>;
      midi: ArrayBuffer;
      noteLayout: LayoutEntry[];
      layoutSource: string;
      staffCount: number;
      warnings: string[];
    }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("transcribe timeout")), 600000);
      worker.onmessage = (ev: MessageEvent) => {
        const m = ev.data;
        if (m.type === "result") {
          clearTimeout(timer);
          resolve(m);
        } else if (m.type === "progress") {
          log(`  ... ${m.stage}`);
        } else if (m.type === "error") {
          clearTimeout(timer);
          reject(new Error(m.message));
        }
      };
      const buf = page.data.buffer as ArrayBuffer;
      worker.postMessage(
        { type: "transcribe-page", pixels: buf, width: page.width, height: page.height, format: "rgba", title: "page demo" },
        [buf],
      );
    });

    log(`staffCount=${result.staffCount}, layoutSource=${result.layoutSource}, warnings=${JSON.stringify(result.warnings)}`);

    // Layer A: exact six-head token match against the oracle (newline records
    // excluded on both sides).
    const symKey = (s: Record<string, string>) => FIELDS.map((f) => s[f]).join("|");
    const gotTokens = result.symbols.flat().filter((s) => s.rhythm !== "newline").map(symKey);
    const wantTokens = oracle.filter((s) => s.rhythm !== "newline").map(symKey);
    const exact = gotTokens.filter((t, i) => t === wantTokens[i]).length;
    const layerAPass = gotTokens.length === wantTokens.length && exact === wantTokens.length;
    log(`Layer A tokens: ${exact}/${wantTokens.length} exact (got ${gotTokens.length} symbols)`);

    // Layer B: canonical (tick,pitch,duration,staff) events derived from the
    // worker's noteLayout on the known 72 BPM / 480 TPQ clock.
    const SPT = 60 / 72 / 480;
    const gotNotes = result.noteLayout
      .map((n) => [Math.round(n.startSec / SPT), n.pitch, Math.round((n.endSec - n.startSec) / SPT), 0] as [number, number, number, number])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const matched = gotNotes.filter((g, i) =>
      i < WANT_NOTES.length &&
      g[0] === WANT_NOTES[i][0] && g[1] === WANT_NOTES[i][1] &&
      g[2] === WANT_NOTES[i][2] && g[3] === WANT_NOTES[i][3]).length;
    const layerBPass = gotNotes.length === WANT_NOTES.length && matched === WANT_NOTES.length;
    log(`Layer B MIDI: ${matched}/${WANT_NOTES.length} canonical events (got ${gotNotes.length})`);
    log(`  got pitches: [${gotNotes.map((g) => g[1]).join(",")}]`);

    const { formatOk, size } = checkMidi(new Uint8Array(result.midi));
    log(`MIDI bytes: ${size}, format-1/480TPQ: ${formatOk}`);

    // Layer C: one layout entry per sounding note, and an "attention" claim
    // is valid only when every entry carries a box.
    const boxed = result.noteLayout.filter((n) => n.box !== null).length;
    const layerCPass =
      result.noteLayout.length === WANT_NOTES.length &&
      (result.layoutSource === "attention"
        ? boxed === result.noteLayout.length
        : result.layoutSource === "midi-fallback");
    log(`Layer C layout: ${boxed}/${result.noteLayout.length} boxed, source=${result.layoutSource}`);

    const pass = result.staffCount === 1 && layerAPass && layerBPass && layerCPass && formatOk;
    done({
      webgpu: workerWebGpu,
      shaderF16,
      encoder: encoderName,
      staffCount: result.staffCount,
      layerA: { exact, total: wantTokens.length, pass: layerAPass },
      layerB: { matched, total: WANT_NOTES.length, pass: layerBPass },
      layerC: { entries: result.noteLayout.length, boxed, layoutSource: result.layoutSource, pass: layerCPass },
      midiBytes: size,
      midiFormatOk: formatOk,
      warnings: result.warnings,
      pass,
    });
  } catch (e) {
    done({
      webgpu: false, shaderF16: false, encoder: "?", staffCount: 0,
      layerA: { exact: 0, total: 0, pass: false },
      layerB: { matched: 0, total: 0, pass: false },
      layerC: { entries: 0, boxed: 0, layoutSource: "?", pass: false },
      midiBytes: 0, midiFormatOk: false, warnings: [],
      pass: false, error: e instanceof Error ? e.message : String(e),
    });
  }
}

void main();
