// Render timeouts (telemetry audit): 13 of 55 server renders hit a flat 180 s RENDER_TIMEOUT while renders run at
// ~1.1x real time and the duration limits admit up to 180/300/600 s. The budget now scales with the song length.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testConfig } from "./helpers.ts";
import { serverRenderTimeoutMs, type ServerRenderPool } from "../src/mcp/server-render.ts";
import { RenderService } from "../src/mcp/browser-render.ts";
import { McpStore } from "../src/mcp/store.ts";
import { emptyProject } from "../../src/workstation/model.ts";

test("serverRenderTimeoutMs: 2x length + 30 s, floored at SERVER_RENDER_TIMEOUT_MS, capped at the longest allowed song", () => {
  const sr = testConfig({}).serverRender; // defaults: 180 s floor, guest 180 s, account 300 s, pro 600 s
  assert.equal(sr.timeoutMs, 180_000);
  assert.equal(serverRenderTimeoutMs(10, sr), 180_000, "short songs keep the floor");
  assert.equal(serverRenderTimeoutMs(183, sr), 396_000, "longest guest song (180 s + 3 s tail)");
  assert.equal(serverRenderTimeoutMs(303, sr), 636_000, "longest free-account song");
  assert.equal(serverRenderTimeoutMs(600, sr), 1_230_000, "longest pro song");
  assert.equal(serverRenderTimeoutMs(10_000, sr), 1_230_000, "capped");
  assert.equal(serverRenderTimeoutMs(Number.NaN, sr), 180_000);
  // every admitted length finishes at 1.1x real time with room to spare
  for (const s of [30, 120, 183, 303, 600]) assert.ok(serverRenderTimeoutMs(s, sr) > 1.1 * s * 1000 + 20_000, `${s} s`);
  // an operator-raised floor still wins
  assert.equal(serverRenderTimeoutMs(10, { ...sr, timeoutMs: 900_000 }), 900_000);
  assert.equal(serverRenderTimeoutMs(10_000, { ...sr, timeoutMs: 2_000_000 }), 2_000_000);
});

test("submitServer hands the pool a length-scaled timeout (renderer timeout + stall too)", () => {
  const cfg = testConfig({});
  const store = new McpStore(":memory:", mkdtempSync(join(tmpdir(), "gbk-rt-")));
  const seen: { timeoutMs?: number; stallMs?: number }[] = [];
  const pool = { enabled: true, inFlight: () => 0, depth: () => 0, cancel: () => {},
    run: (_id: string, _o: string, _p: unknown, options: { timeoutMs?: number; stallMs?: number }) => { seen.push(options); return new Promise(() => {}); } } as unknown as ServerRenderPool;
  const svc = new RenderService(cfg, store, { hasStudio: () => false } as never, () => {}, () => 1000, pool);
  const project = { ...emptyProject("Long"), endTick: 960 * 240 }; // 240 s at 120 bpm, ppq 480
  svc.submitServer("acct-1", { id: "cmp-1", revision: 1 } as never, project, { sampleRate: 44100, channels: 2, format: "wav", tailSeconds: 3 } as never, { guest: false });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].timeoutMs, 2 * 243_000 + 30_000); assert.equal(seen[0].stallMs, seen[0].timeoutMs);
  store.close();
});
