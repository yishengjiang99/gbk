// Stress: a multi-minute, multi-track, CC-dense project renders through the same headless path with bounded memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./support/compose-setup.ts";
import { renderProjectOffline } from "../src/audio/offline-renderer.ts";
import { validateWav } from "../src/audio/audio-validation.ts";

test("stress: 5-minute, 12-track project with dense CC renders, validates and stays memory-bounded", async () => {
  const { c, call } = setup();
  await call("gbk_create_project", { name: "Stress", tempo: 120, replaceCurrent: true });
  const programs = [0, 4, 24, 32, 40, 41, 42, 48, 56, 68, 73, 89];
  const tr = await call("gbk_create_track", { tracks: programs.map((program, i) => ({ name: `T${i}`, program })) });
  assert.equal(tr.ok, true);
  const p = structuredClone(c.project);
  const bars = 150; // 150 bars of 4/4 at 120 BPM = 300 s
  let id = 0;
  p.tracks.forEach((t, ti) => {
    for (let b = 0; b < bars; b++) for (let q = 0; q < 4; q++) {
      const tick = (b * 4 + q) * p.ppq;
      p.notes.push({ id: `n${id++}`, trackId: t.id, channel: t.channel, pitch: 48 + ((ti * 5 + b + q * 3) % 24), velocity: 50 + ((b + q) % 40), tick, duration: p.ppq } as never);
      p.ccs.push({ id: `c${id++}`, trackId: t.id, channel: t.channel, controller: 11, tick, value: 60 + ((b * 4 + q) % 60) } as never);
    }
  });
  const heap0 = process.memoryUsage().heapUsed;
  let peakHeap = heap0;
  const t0 = performance.now();
  const r = await renderProjectOffline(p, { sampleRate: 44100, channels: 2, format: "pcm16", tailSeconds: 2 }, undefined,
    () => { peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed); });
  const ms = performance.now() - t0;
  const v = await validateWav(r.bytes, { sampleRate: 44100, channels: 2, durationSeconds: 302, toleranceSeconds: 0.01 });
  const outMB = r.bytes.byteLength / 2 ** 20, heapMB = (peakHeap - heap0) / 2 ** 20;
  process.stderr.write(`stress: notes=${p.notes.length} ccs=${p.ccs.length} audio=${r.durationSeconds}s render=${(ms / 1000).toFixed(1)}s (${(r.durationSeconds / (ms / 1000)).toFixed(1)}x realtime) wav=${outMB.toFixed(1)}MB heapDelta=${heapMB.toFixed(1)}MB peak=${r.peakDbFS}dBFS clipped=${r.clippedSamples}\n`);
  assert.equal(v.info.channels, 2);
  assert.ok(r.durationSeconds > 300);
  assert.ok(ms < 240_000, "renders faster than ~1.25x realtime on CI-class hardware");
  // Encoded output is preallocated once; the engine must not accumulate per-chunk buffers (allow 2x output + slack).
  assert.ok(heapMB < outMB * 2 + 64, `heap growth ${heapMB.toFixed(1)}MB`);
});
