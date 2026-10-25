// The parallel worker renderer must produce exactly what the OfflineAudioContext graph produces, for any pool size.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSoundFont } from "../src/audio/soundfont-loader.ts";
import { buildRenderPlan } from "../src/audio/offline-renderer.ts";
import { renderPlanOffline } from "../src/audio/offline-context.ts";
import { nodeOfflineEnv } from "../src/audio/node-offline-env.ts";
import { parseSmf } from "../src/workstation/smf.ts";
import { runTrackRenderWorker, type FromWorker, type ToWorker, type WorkerScope } from "../src/audio/track-render-worker-core.ts";
import type { WorkerLike } from "../src/audio/parallel-render.ts";

/** In-process stand-in for a Web Worker running track-render.worker.ts (async message delivery, like the real thing). */
function fakeSpawn(): WorkerLike {
  const scope: WorkerScope = { onmessage: null, postMessage: (m: FromWorker) => setTimeout(() => w.onmessage?.({ data: m }), 0) };
  const w: WorkerLike = { onmessage: null, onerror: null, terminate: () => { scope.onmessage = null; },
    postMessage: (m: ToWorker) => setTimeout(() => scope.onmessage?.({ data: m }), 0) };
  runTrackRenderWorker(scope);
  return w;
}

const sf = parseSoundFont(new Uint8Array(readFileSync("public/static/GeneralUser-GS.sf2")));

test("parallel worker render is sample-identical to the OfflineAudioContext graph", async () => {
  const p = parseSmf(new Uint8Array(readFileSync("public/static/Queen - Bohemian Rhapsody.mid")), "x");
  const sr = 44100; const plan = buildRenderPlan(p, sf.sf, sr, { endTick: p.ppq * 4 * 6 }); // first 6 bars, all tracks
  plan.pans[1] = -0.5; plan.faders[2] = 0.7; // exercise the full pan/fader matrix
  const total = plan.musicFrames + sr;
  const ref = await renderPlanOffline(plan, sr, total, { env: nodeOfflineEnv(), parallel: false });
  for (const workers of [1, 3, 16]) {
    const got = await renderPlanOffline(plan, sr, total, { env: nodeOfflineEnv(), parallel: { spawn: fakeSpawn, workers } });
    assert.deepEqual(Buffer.from(got.L.buffer), Buffer.from(ref.L.buffer), `L differs with ${workers} workers`);
    assert.deepEqual(Buffer.from(got.R.buffer), Buffer.from(ref.R.buffer), `R differs with ${workers} workers`);
  }
  assert.ok(ref.L.some((x) => x !== 0));
});

test("a pool that cannot start falls back to the OfflineAudioContext graph", async () => {
  const p = parseSmf(new Uint8Array(readFileSync("songs/2026-10-23-midnight-invention/song.mid")), "x");
  const sr = 44100; const plan = buildRenderPlan(p, sf.sf, sr, { endTick: p.ppq * 4 * 2 }); const total = plan.musicFrames;
  const broken = (): WorkerLike => { const w: WorkerLike = { onmessage: null, onerror: null, terminate() {}, postMessage() { setTimeout(() => w.onerror?.({ message: "404" }), 0); } }; return w; };
  const ref = await renderPlanOffline(plan, sr, total, { env: nodeOfflineEnv(), parallel: false });
  const got = await renderPlanOffline(plan, sr, total, { env: nodeOfflineEnv(), parallel: { spawn: broken } });
  assert.deepEqual(Buffer.from(got.L.buffer), Buffer.from(ref.L.buffer));
});

test("cancelling a parallel render rejects with OPERATION_CANCELLED", async () => {
  const p = parseSmf(new Uint8Array(readFileSync("songs/2026-10-23-midnight-invention/song.mid")), "x");
  const plan = buildRenderPlan(p, sf.sf, 44100); const ac = new AbortController();
  const run = renderPlanOffline(plan, 44100, plan.musicFrames, { parallel: { spawn: fakeSpawn }, signal: ac.signal, onProgress: (x) => { if (x > 0) ac.abort(); } });
  await assert.rejects(run, (e: Error & { code?: string }) => e.code === "OPERATION_CANCELLED");
});
