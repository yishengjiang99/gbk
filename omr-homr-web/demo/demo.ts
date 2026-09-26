/* Browser demo page script (isolated technical demo, not product UI).
 * Drives the real omr-homr-web Worker end-to-end in the browser:
 * load (fp16 encoder on WebGPU when available, else fp32 on WASM) ->
 * transcribe the C-scale staff fixture -> compare symbols/MIDI vs oracle.
 */
const $ = (id: string) => document.getElementById(id)!;
const logEl = $("log");
const resultEl = $("result");

function log(msg: string): void {
  logEl.textContent += msg + "\n";
}

interface DemoResult {
  webgpu: boolean;
  shaderF16: boolean;
  encoder: string;
  symbolCount: number;
  tokenDistance: number;
  midiDistance: number;
  midiBytes: number;
  midiFormatOk: boolean;
  layoutSource: string;
  pass: boolean;
  error?: string;
}

const FIELDS = ["rhythm", "pitch", "lift", "articulation", "slur", "position"];

function editDistance(a: string[], b: string[]): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1)
    for (let j = 1; j <= b.length; j += 1)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

async function staffPixels(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 1280, 256);
  ctx.drawImage(bmp, 0, 0, 1280, 256);
  const data = ctx.getImageData(0, 0, 1280, 256).data;
  const gray = new Uint8Array(1280 * 256);
  for (let i = 0; i < gray.length; i += 1)
    gray[i] = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
  return gray;
}

function checkMidi(bytes: Uint8Array): { formatOk: boolean; size: number } {
  const fmt = (bytes[8] << 8) | bytes[9];
  const division = (bytes[12] << 8) | bytes[13];
  const ok =
    bytes[0] === 0x4d && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64 &&
    fmt === 1 && division === 480;
  return { formatOk: ok, size: bytes.length };
}

async function main(): Promise<void> {
  const done = (r: DemoResult) => {
    (window as unknown as { __demoResult: DemoResult }).__demoResult = r;
    resultEl.textContent = JSON.stringify(r, null, 2);
    log(r.pass ? "DEMO PASS" : `DEMO FAIL${r.error ? ": " + r.error : ""}`);
  };
  try {
    // fp16 compute needs the WGSL shader-f16 feature (absent on SwiftShader);
    // fall back to the fp32 encoder on WebGPU rather than fake an fp16 run.
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
    const encoderUrl = shaderF16
      ? "/models/transformer_encoder_model_fp16.onnx"
      : "/models/transformer_encoder_model_fp32.onnx";
    log(`WebGPU ${webgpu ? "available" : "unavailable"}, shader-f16 ${shaderF16 ? "yes" : "no"} -> ${shaderF16 ? "fp16" : "fp32"} encoder`);

    const [pixels, oracle, notesCsv] = await Promise.all([
      staffPixels("/fixtures/mono.c_major_scale/input.png"),
      fetch("/fixtures/mono.c_major_scale/expected.tokens.json").then((r) => r.json()),
      fetch("/fixtures/mono.c_major_scale/expected.notes.csv").then((r) => r.text()),
    ]);
    const wantNotes = notesCsv.trim().split("\n").slice(1).map((l) => l.trim()).sort();
    log(`fixture loaded: ${oracle.length} oracle symbols, ${wantNotes.length} expected notes`);

    const worker = new Worker("/demo/dist/worker.bundle.js");
    const encoderName = `${shaderF16 ? "fp16" : "fp32"} (WebGPU strict)`;
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
      wasmPaths: "/node_modules/onnxruntime-web/dist/",
      strictWebGpu: true,
    });
    const workerWebGpu = await ready;

    const result = await new Promise<{
      symbols: Array<Record<string, string>>;
      midi: ArrayBuffer;
      noteLayout: Array<{ pitch: number; startSec: number; endSec: number }>;
      layoutSource: string;
    }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("transcribe timeout")), 300000);
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
      const buf = pixels.buffer as ArrayBuffer;
      worker.postMessage({ type: "transcribe-staff", pixels: buf, width: 1280, height: 256, title: "browser demo" }, [buf]);
    });

    const symKey = (s: Record<string, string>) => FIELDS.map((f) => s[f]).join("|");
    const tokenDistance = editDistance(result.symbols.map(symKey), oracle.map(symKey));
    log(`tokens: ${result.symbols.length} symbols, distance vs oracle = ${tokenDistance}`);

    // Derive the canonical note list from the worker's noteLayout (same 72 BPM / 480 TPQ clock).
    const SPT = 60 / 72 / 480;
    const gotNotes = result.noteLayout
      .map((n) => `${Math.round(n.startSec / SPT)},${n.pitch},${Math.round((n.endSec - n.startSec) / SPT)},0`)
      .sort();
    const midiDistance = editDistance(gotNotes, wantNotes);
    log(`MIDI notes: ${gotNotes.length}, distance vs GT = ${midiDistance}`);

    const { formatOk, size } = checkMidi(new Uint8Array(result.midi));
    log(`MIDI bytes: ${size}, format-1/480TPQ: ${formatOk}, layoutSource=${result.layoutSource}`);

    const pass = tokenDistance === 0 && midiDistance === 0 && formatOk;
    done({ webgpu: workerWebGpu, shaderF16, encoder: encoderName, symbolCount: result.symbols.length, tokenDistance, midiDistance, midiBytes: size, midiFormatOk: formatOk, layoutSource: result.layoutSource, pass });
  } catch (e) {
    done({ webgpu: false, shaderF16: false, encoder: "?", symbolCount: 0, tokenDistance: -1, midiDistance: -1, midiBytes: 0, midiFormatOk: false, layoutSource: "?", pass: false, error: e instanceof Error ? e.message : String(e) });
  }
}

void main();
