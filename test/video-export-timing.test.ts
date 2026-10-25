import { test } from "node:test";
import assert from "node:assert/strict";
import { exportFrameCount, frameTimestampUs, frameDurationUs, audioChunks, exportProgress, evenSize, parseWav } from "../src/video/export-timing.ts";

test("frame count covers the duration exactly", () => {
  assert.equal(exportFrameCount(10, 30), 300);
  assert.equal(exportFrameCount(10.01, 30), 301);
  assert.equal(exportFrameCount(0, 30), 1);
});
test("frame timestamps never drift and durations tile", () => {
  assert.equal(frameTimestampUs(0, 30), 0);
  assert.equal(frameTimestampUs(1, 30), 33333);
  assert.equal(frameTimestampUs(30 * 3600, 30), 3600 * 1e6);
  let t = 0; for (let i = 0; i < 1000; i++) { assert.equal(frameTimestampUs(i, 30), t); t += frameDurationUs(i, 30); }
});
test("audio chunks tile the samples with matching timestamps", () => {
  const c = audioChunks(44100 * 2 + 5, 44100, 4096);
  assert.equal(c.reduce((s, x) => s + x.length, 0), 44100 * 2 + 5);
  assert.equal(c[1].timestampUs, Math.round((4096 * 1e6) / 44100));
  assert.equal(c[c.length - 1].start + c[c.length - 1].length, 44100 * 2 + 5);
});
test("progress and size helpers", () => {
  assert.equal(exportProgress("audio", 1), 0.35); assert.equal(exportProgress("video", 0), 0.35); assert.equal(exportProgress("video", 2), 1);
  assert.deepEqual(evenSize(720), { width: 1280, height: 720 });
  assert.equal(evenSize(721).height % 2, 0);
});
test("parseWav reads pcm16 stereo", () => {
  const n = 3, b = new Uint8Array(44 + n * 4), dv = new DataView(b.buffer);
  const w = (o: number, s: string) => [...s].forEach((ch, i) => (b[o + i] = ch.charCodeAt(0)));
  w(0, "RIFF"); dv.setUint32(4, 36 + n * 4, true); w(8, "WAVE"); w(12, "fmt "); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, 48000, true); dv.setUint16(34, 16, true);
  w(36, "data"); dv.setUint32(40, n * 4, true); dv.setInt16(44, 16384, true); dv.setInt16(46, -32768, true);
  const r = parseWav(b); assert.equal(r.sampleRate, 48000); assert.equal(r.channels.length, 2); assert.equal(r.channels[0][0], 0.5); assert.equal(r.channels[1][0], -1);
});
