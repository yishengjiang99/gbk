/*
 * Worker JSON protocol tests: the sheet-cam boundary. Covers load,
 * transcribe-staff (the preserved Phase 2 API), and transcribe-page
 * (Phase 3) response schemas. Model-backed; skips when models are absent.
 *
 * The worker is imported in-process with minimal shims (self, Cache API,
 * file:// fetch) so the real message dispatch and postMessage wiring are
 * exercised.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PNG } from "pngjs";

const root = dirname(fileURLToPath(import.meta.url));
const modelUrl = (name: string) => pathToFileURL(join(root, "..", "models", name)).href;
const modelsPresent =
  existsSync(join(root, "..", "models", "transformer_encoder_model_fp32.onnx")) &&
  existsSync(join(root, "..", "models", "transformer_decoder_model_fp32.onnx")) &&
  existsSync(join(root, "..", "models", "segnet_model_fp16.onnx"));

// --- minimal worker-environment shims -------------------------------------

const cacheStore = new Map<string, Uint8Array>();
(globalThis as unknown as Record<string, unknown>).caches = {
  open: async (_name: string) => ({
    match: async (key: string) => {
      const bytes = cacheStore.get(String(key));
      if (!bytes) return undefined;
      const copy = bytes.slice();
      return {
        arrayBuffer: async () =>
          copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
        clone() {
          return this;
        },
      };
    },
    put: async (key: string, response: Response) => {
      cacheStore.set(String(key), new Uint8Array(await response.arrayBuffer()));
    },
  }),
};

const origFetch = globalThis.fetch;
(globalThis as unknown as Record<string, unknown>).fetch = async (
  input: string | URL,
  init?: RequestInit,
) => {
  const s = String(input);
  if (s.startsWith("file://")) {
    const bytes = readFileSync(fileURLToPath(s.split("?")[0]));
    return new Response(bytes as unknown as BodyInit, { status: 200 });
  }
  return origFetch(input, init);
};

type Handler = (event: { data: unknown }) => void;
let handler: Handler | null = null;
const posted: unknown[] = [];
(globalThis as unknown as Record<string, unknown>).self = {
  postMessage: (msg: unknown) => {
    posted.push(msg);
  },
  set onmessage(h: Handler | null) {
    handler = h;
  },
  get onmessage() {
    return handler;
  },
};

await import("../src/worker.js");
const { selectLayoutSource } = (await import("../src/worker.js")) as {
  selectLayoutSource: (entryCount: number, attentionBoxes: number) => "attention" | "midi-fallback";
};

async function send(request: unknown, expectType: string): Promise<Record<string, unknown>> {
  posted.length = 0;
  assert.ok(handler, "worker onmessage not installed");
  handler({ data: request });
  const deadline = Date.now() + 300000;
  for (;;) {
    const msg = posted.find(
      (m) => (m as { type: string }).type === expectType || (m as { type: string }).type === "error",
    ) as { type: string; message?: string } | undefined;
    if (msg) {
      if (msg.type === "error") throw new Error(`worker error: ${msg.message}`);
      return msg as Record<string, unknown>;
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${expectType}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function loadModels() {
  return send(
    {
      type: "load",
      encoderUrl: modelUrl("transformer_encoder_model_fp32.onnx"),
      decoderUrl: modelUrl("transformer_decoder_model_fp32.onnx"),
      segnetUrl: modelUrl("segnet_model_fp16.onnx"),
    },
    "ready",
  );
}

describe("layoutSource selection rule (model-free)", () => {
  it("claims attention only when every entry has a box", () => {
    assert.equal(selectLayoutSource(15, 15), "attention");
    assert.equal(selectLayoutSource(1, 1), "attention");
  });
  it("falls back on partial or missing attention coverage", () => {
    assert.equal(selectLayoutSource(15, 0), "midi-fallback");
    assert.equal(selectLayoutSource(15, 14), "midi-fallback");
    assert.equal(selectLayoutSource(15, 1), "midi-fallback");
  });
  it("falls back when there are no sounding notes", () => {
    assert.equal(selectLayoutSource(0, 0), "midi-fallback");
  });
});

describe("worker protocol", { skip: !modelsPresent }, () => {
  it("load posts ready", async () => {
    const ready = await loadModels();
    assert.equal(ready.type, "ready");
  });

  it("transcribe-staff preserves the Phase 2 response shape", async () => {
    await loadModels();
    const crop = PNG.sync.read(readFileSync(join(root, "fixtures", "c-scale-staff-0_oracle.png")));
    assert.equal(crop.width, 1280);
    assert.equal(crop.height, 256);
    const gray = new Uint8Array(1280 * 256);
    for (let i = 0; i < gray.length; i++) gray[i] = crop.data[i * 4];
    const result = await send(
      { type: "transcribe-staff", pixels: gray.buffer, width: 1280, height: 256 },
      "result",
    );
    assert.ok(result.midi instanceof ArrayBuffer);
    assert.ok((result.midi as ArrayBuffer).byteLength > 100);
    assert.ok(Array.isArray(result.noteLayout));
    assert.ok(["attention", "midi-fallback"].includes(result.layoutSource as string));
    assert.equal(typeof result.staffCount, "number");
    assert.ok(Array.isArray(result.warnings));
    assert.ok(Array.isArray(result.symbols));
    // C-scale staff decodes to notes.
    assert.ok((result.symbols as unknown[]).length > 10);
    const staffLayout = result.noteLayout as { box: unknown }[];
    assert.ok(staffLayout.length > 0);
    // Layer C invariant: an "attention" claim implies every entry has a box.
    if (result.layoutSource === "attention") {
      assert.ok(staffLayout.every((l) => l.box !== null));
    }
  });

  it("transcribe-page without segnet reports a clear error", async () => {
    await send(
      {
        type: "load",
        encoderUrl: modelUrl("transformer_encoder_model_fp32.onnx"),
        decoderUrl: modelUrl("transformer_decoder_model_fp32.onnx"),
      },
      "ready",
    );
    const page = PNG.sync.read(
      readFileSync(join(root, "..", "..", "test", "fixtures", "ocr-ground-truth", "c-scale.png")),
    );
    const pixels = new Uint8Array(page.data.buffer.slice(
      page.data.byteOffset,
      page.data.byteOffset + page.data.byteLength,
    ));
    await assert.rejects(
      send(
        { type: "transcribe-page", pixels: pixels.buffer, width: page.width, height: page.height, format: "rgba" },
        "result",
      ),
      /segnet/i,
    );
  });

  it("transcribe-page returns midi, layout, staffCount and warnings", async () => {
    await loadModels();
    const page = PNG.sync.read(
      readFileSync(join(root, "..", "..", "test", "fixtures", "ocr-ground-truth", "c-scale.png")),
    );
    const pixels = new Uint8Array(page.data.buffer.slice(
      page.data.byteOffset,
      page.data.byteOffset + page.data.byteLength,
    ));
    const result = await send(
      {
        type: "transcribe-page",
        pixels: pixels.buffer,
        width: page.width,
        height: page.height,
        format: "rgba",
        title: "c-scale",
      },
      "result",
    );
    // Schema: the only sheet-cam boundary.
    assert.ok(result.midi instanceof ArrayBuffer);
    assert.ok((result.midi as ArrayBuffer).byteLength > 100);
    assert.ok(Array.isArray(result.noteLayout));
    assert.equal(result.layoutSource, "attention");
    assert.equal(result.staffCount, 1);
    assert.ok(Array.isArray(result.warnings));
    assert.ok(Array.isArray(result.symbols));
    const layout = result.noteLayout as { pitch: number; box: unknown }[];
    assert.equal(layout.length, 15);
    // Layer C: one layout entry per sounding MIDI note; an "attention" claim
    // implies every entry has a box.
    assert.ok(layout.every((l) => l.box !== null));
    const symbols = result.symbols as { rhythm: string }[][];
    assert.equal(symbols.length, 1);
    assert.equal(symbols[0].filter((s) => s.rhythm !== "newline").length, 21);
  });
});
