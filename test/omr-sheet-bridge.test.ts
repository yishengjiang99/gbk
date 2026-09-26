import test from "node:test";
import assert from "node:assert/strict";

import {
  mapBoxToPhoto,
  omrModelUrls,
  omrResultToScanResult,
} from "../src/omr-sheet-bridge.ts";

test("mapBoxToPhoto maps a preprocessed-page box onto photo pixels", () => {
  // Photo 2000x1000, autocropped to (100, 50, 1800, 900), page is 1920x960.
  const box = mapBoxToPhoto(
    { x: 192, y: 96, w: 96, h: 48 },
    { srcWidth: 2000, srcHeight: 1000, cropX: 100, cropY: 50, cropW: 1800, cropH: 900, pageWidth: 1920, pageHeight: 960 },
  );
  // scale = 1800/1920 = 0.9375
  assert.equal(box.x, 100 + 192 * 0.9375);
  assert.equal(box.y, 50 + 96 * 0.9375);
  assert.equal(box.w, 96 * 0.9375);
  assert.equal(box.h, 48 * 0.9375);
});

test("omrResultToScanResult maps layout boxes and keeps MIDI bytes", () => {
  const midi = new ArrayBuffer(16);
  const result = omrResultToScanResult("photo.jpg", 2000, 1000, {
    midi,
    noteLayout: [
      { pitch: 60, startSec: 0, endSec: 0.5, box: { x: 0, y: 0, w: 1920, h: 960 } },
      { pitch: 62, startSec: 0.5, endSec: 1, box: null },
    ],
    layoutSource: "attention",
    staffCount: 1,
    warnings: ["w1"],
    pageMapping: {
      srcWidth: 2000, srcHeight: 1000,
      cropX: 0, cropY: 0, cropW: 2000, cropH: 1000,
      pageWidth: 1920, pageHeight: 960,
    },
  });
  assert.equal(result.midiData, midi);
  assert.equal(result.fileName, "photo-omr.mid");
  assert.equal(result.imageWidth, 2000);
  assert.equal(result.imageHeight, 1000);
  assert.equal(result.noteLayout.length, 2);
  // full-page box maps to the full photo (within float error)
  const bbox = result.noteLayout[0].bbox;
  for (const [k, v] of [["x", 0], ["y", 0], ["w", 2000], ["h", 1000]] as const) {
    assert.ok(Math.abs(bbox[k] - v) < 1e-9, `${k}: ${bbox[k]} ~= ${v}`);
  }
  assert.equal(result.noteLayout[0].pitch, 60);
  // null box degrades to a zero box (playback still works)
  assert.deepEqual(result.noteLayout[1].bbox, { x: 0, y: 0, w: 0, h: 0 });
  assert.ok(result.warnings.some((w) => w.includes("homr")));
  assert.ok(result.warnings.includes("w1"));
});

test("omrResultToScanResult without pageMapping emits zero boxes", () => {
  const result = omrResultToScanResult("photo.jpg", 640, 480, {
    midi: new ArrayBuffer(8),
    noteLayout: [{ pitch: 60, startSec: 0, endSec: 1, box: { x: 1, y: 2, w: 3, h: 4 } }],
    layoutSource: "midi-fallback",
    staffCount: 2,
    warnings: [],
  });
  assert.deepEqual(result.noteLayout[0].bbox, { x: 0, y: 0, w: 0, h: 0 });
  assert.equal(result.imageWidth, 640);
  assert.equal(result.imageHeight, 480);
});

test("omrModelUrls points at the configured base and picks fp32 without WebGPU", () => {
  // node has no navigator.gpu, so the WASM-safe fp32 encoder is selected
  const urls = omrModelUrls("/omr-models/");
  assert.equal(urls.encoderUrl, "/omr-models/transformer_encoder_model_fp32.onnx");
  assert.equal(urls.decoderUrl, "/omr-models/transformer_decoder_model_fp32.onnx");
  assert.equal(urls.segnetUrl, "/omr-models/segnet_model_fp16.onnx");
  const custom = omrModelUrls("https://cdn.example.com/m/");
  assert.ok(custom.encoderUrl.startsWith("https://cdn.example.com/m/"));
});
