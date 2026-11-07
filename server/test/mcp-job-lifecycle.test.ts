// Phase 1 MCP job lifecycle: legal transitions, progress-only patches, and atomic status+artifact
// publication. Temporary local DBs only — no ffmpeg, no production music.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testConfig } from "./helpers.ts";
import { McpStore, type RenderJobRow } from "../src/mcp/store.ts";
import { DEFAULT_RENDER_CONFIG, RenderService } from "../src/mcp/browser-render.ts";
import { McpError } from "../src/mcp/errors.ts";
import type { ServerRenderPool } from "../src/mcp/server-render.ts";
import { emptyProject } from "../../src/workstation/model.ts";

const SMF = new Uint8Array([
  0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x01, 0x00, 0x01, 0x01, 0xe0,
  0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x04, 0x00, 0xff, 0x2f, 0x00,
]);

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "gbk-job-lc-"));
  return { dir, store: new McpStore(join(dir, "mcp.sqlite"), dir) };
}
function seed(store: McpStore, owner = "alice") {
  const snapshot = emptyProject("Lifecycle");
  snapshot.endTick = 480;
  const row = store.createComposition({ owner, title: "Lifecycle", projectJson: JSON.stringify(snapshot), revision: 1 });
  return { row, snapshot };
}
function midiRow(job: RenderJobRow) {
  return {
    job_id: job.id, composition_id: job.composition_id, owner: job.owner, revision: job.revision,
    kind: "midi" as const, filename: "t.mid", mime_type: "audio/midi", size_bytes: SMF.length, sha256: "abcd",
    rel_path: `${job.id}.mid`, meta_json: "{}",
  };
}
function hungPool(): ServerRenderPool {
  return { enabled: true, inFlight: () => 0, depth: () => 0, run: () => new Promise(() => {}), cancel() {} } as unknown as ServerRenderPool;
}

test("patchJob cannot change status or touch a cancelled job", () => {
  const { store } = openStore();
  try {
    const job = store.createJob({ compositionId: "cmp_x", owner: "alice", revision: 1, config: {} });
    store.patchJob(job.id, { progress: 0.2 });
    assert.equal(store.getJob(job.id, "alice")!.progress, 0.2);
    assert.equal(store.transitionJob(job.id, ["queued"], { status: "cancelled", finished_at: Date.now() }), true);
    store.patchJob(job.id, { progress: 0.4 });
    assert.equal(store.getJob(job.id, "alice")!.status, "cancelled");
    assert.equal(store.getJob(job.id, "alice")!.progress, 0.2);
    const forged = { progress: 0.9, status: "running" as const };
    store.patchJob(job.id, forged);
    assert.equal(store.getJob(job.id, "alice")!.status, "cancelled");
    assert.equal(store.getJob(job.id, "alice")!.progress, 0.2);
  } finally { store.close(); }
});

test("illegal transitions cannot resurrect a terminal job", () => {
  const { store } = openStore();
  try {
    for (const terminal of ["completed", "failed", "cancelled"] as const) {
      const job = store.createJob({ compositionId: "cmp_x", owner: "alice", revision: 1, config: {} });
      assert.equal(store.transitionJob(job.id, ["queued"], { status: terminal, finished_at: Date.now(), ...(terminal === "failed" ? { error: "x" } : {}) }), true);
      assert.equal(store.transitionJob(job.id, ["queued"], { status: "running" }), false);
      assert.equal(store.transitionJob(job.id, [terminal], { status: "running" }), false);
      assert.equal(store.transitionJob(job.id, ["queued", "running"], { status: "failed", error: "late" }), false);
      assert.equal(store.getJob(job.id, "alice")!.status, terminal);
    }
  } finally { store.close(); }
});

test("publish after cancel is a no-op; double finish keeps one artifact set", () => {
  const { store } = openStore();
  try {
    const cancelled = store.createJob({ compositionId: "cmp_x", owner: "alice", revision: 1, config: {} });
    assert.equal(store.transitionJob(cancelled.id, ["queued"], { status: "running" }), true);
    assert.equal(store.transitionJob(cancelled.id, ["queued", "running"], { status: "cancelled", finished_at: Date.now() }), true);
    assert.equal(store.publishAndTransition(cancelled.id, ["queued", "running"], { status: "completed", error: null, finished_at: Date.now(), progress: 1 }, [midiRow(cancelled)]), null);
    assert.equal(store.getJob(cancelled.id, "alice")!.status, "cancelled");
    assert.equal(store.listArtifacts("cmp_x", "alice").length, 0);

    const done = store.createJob({ compositionId: "cmp_x", owner: "alice", revision: 1, config: {} });
    assert.equal(store.transitionJob(done.id, ["queued"], { status: "running" }), true);
    const first = store.publishAndTransition(done.id, ["queued", "running"], { status: "completed", error: null, finished_at: Date.now(), progress: 1 }, [midiRow(done)]);
    assert.equal(first?.length, 1);
    assert.equal(store.publishAndTransition(done.id, ["queued", "running"], { status: "completed", error: null, finished_at: Date.now(), progress: 1 }, [midiRow(done)]), null);
    assert.equal(store.getJob(done.id, "alice")!.status, "completed");
    assert.equal(store.listArtifacts("cmp_x", "alice").filter((a) => a.job_id === done.id).length, 1);
  } finally { store.close(); }
});

test("failed publication rolls back status and inserts no artifacts", () => {
  const { store } = openStore();
  try {
    const job = store.createJob({ compositionId: "cmp_x", owner: "alice", revision: 1, config: {} });
    assert.equal(store.transitionJob(job.id, ["queued"], { status: "running" }), true);
    assert.throws(() => store.publishAndTransition(job.id, ["queued", "running"], { status: "completed", error: null, finished_at: Date.now(), progress: 1 }, [
      midiRow(job),
      { ...midiRow(job), kind: null as never },
    ]));
    assert.equal(store.getJob(job.id, "alice")!.status, "running");
    assert.equal(store.listArtifacts("cmp_x", "alice").length, 0);
  } finally { store.close(); }
});

test("MIDI-only path completes queued→completed with MIDI and no WAV", () => {
  const { store } = openStore();
  const { row, snapshot } = seed(store);
  const renders = new RenderService(testConfig(), store, () => null);
  try {
    const queued = store.createJob({ compositionId: row.id, owner: "alice", revision: row.revision, config: {} });
    const published = store.publishAndTransition(queued.id, ["queued", "running"], { status: "completed", error: null, finished_at: Date.now(), progress: 1 }, [midiRow(queued)]);
    assert.equal(published?.length, 1);
    assert.equal(store.getJob(queued.id, "alice")!.status, "completed");

    const job = renders.midiOnlyJob("alice", row, snapshot, DEFAULT_RENDER_CONFIG, SMF, 10);
    assert.equal(job.status, "completed");
    assert.equal(job.progress, 1);
    const arts = store.listArtifacts(row.id, "alice").filter((a) => a.job_id === job.id);
    assert.equal(arts.length, 1);
    assert.equal(arts[0].kind, "midi");
    assert.ok(existsSync(join(store.artifactsDir, `${job.id}.mid`)));
    assert.equal(renders.jobView("alice", job).artifacts.length, 1);
  } finally { store.close(); }
});

test("dispatch promotions are queued→running for widget, studio, and server paths", () => {
  const { store } = openStore();
  const { row, snapshot } = seed(store);
  const cfg = testConfig();
  const widget = new RenderService(cfg, store, () => null);
  const studio = new RenderService(cfg, store, () => ({ ready: true, callTool: () => new Promise(() => {}) }));
  const server = new RenderService(cfg, store, () => null, () => {}, () => cfg.mcp.maxRendersPerDay, hungPool());
  try {
    const w = widget.submitWidget("alice", row, snapshot, DEFAULT_RENDER_CONFIG);
    assert.equal(w.job.status, "running");
    assert.equal(store.transitionJob(w.job.id, ["queued"], { status: "running" }), false);
    assert.equal(widget.cancel("alice", w.job.id).status, "cancelled");

    const sub = studio.submit("alice", row, snapshot, DEFAULT_RENDER_CONFIG);
    assert.ok("job" in sub);
    assert.equal(sub.job.status, "running");
    assert.equal(studio.cancel("alice", sub.job.id).status, "cancelled");

    const sj = server.submitServer("alice", row, snapshot, DEFAULT_RENDER_CONFIG, { guest: false });
    assert.equal(sj.status, "running");
    assert.equal(server.cancel("alice", sj.id).status, "cancelled");
  } finally { void widget.stop(); void studio.stop(); void server.stop(); store.close(); }
});

test("cancel vs late widget finish cannot publish; stop discards the partial upload", () => {
  const { dir, store } = openStore();
  const { row, snapshot } = seed(store);
  const renders = new RenderService(testConfig(), store, () => null);
  try {
    const stopped = renders.submitWidget("alice", row, snapshot, DEFAULT_RENDER_CONFIG);
    if (!("token" in stopped)) assert.fail("promotion succeeded so token is present");
    const stoppedTok = stopped.token!;
    assert.equal(existsSync(join(store.artifactsDir, `${stopped.job.id}.wav.part`)), true);
    renders.acceptChunk(stopped.job.id, stoppedTok, 0, new Uint8Array([1, 2, 3, 4]));
    const fin = renders.finishWidget("alice", stopped.job.id, stoppedTok, { ok: false, code: "OPERATION_CANCELLED", message: "stopped" });
    assert.equal(fin.status, "failed");
    assert.equal(JSON.parse(fin.error ?? "{}").code, "OPERATION_CANCELLED");
    assert.equal(store.listArtifacts(row.id, "alice").length, 0);
    assert.equal(existsSync(join(store.artifactsDir, `${stopped.job.id}.wav.part`)), false);
    assert.throws(() => renders.finishWidget("alice", stopped.job.id, stoppedTok, { ok: false, code: "OPERATION_CANCELLED", message: "stopped" }),
      (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND");

    const live = renders.submitWidget("alice", row, snapshot, DEFAULT_RENDER_CONFIG);
    if (!("token" in live)) assert.fail("promotion succeeded so token is present");
    const liveTok = live.token!;
    renders.acceptChunk(live.job.id, liveTok, 0, new Uint8Array([1, 2, 3, 4]));
    const c1 = renders.cancel("alice", live.job.id);
    const c2 = renders.cancel("alice", live.job.id);
    assert.equal(c1.status, "cancelled");
    assert.equal(c2.status, "cancelled");
    assert.equal(existsSync(join(store.artifactsDir, `${live.job.id}.wav.part`)), false);
    assert.throws(() => renders.finishWidget("alice", live.job.id, liveTok, { ok: true, meta: { sha256: "x", validated: true } }),
      (e: unknown) => e instanceof McpError && e.code === "NOT_FOUND");
    assert.equal(renders.status("alice", live.job.id).status, "cancelled");
    assert.equal(store.listArtifacts(row.id, "alice").length, 0);
    assert.equal(renders.jobView("alice", renders.status("alice", live.job.id)).artifacts.length, 0);
  } finally { void renders.stop(); store.close(); }
});

test("startup recovery fails leftover running and queued jobs without publishing artifacts", async () => {
  const { dir, store } = openStore();
  const running = store.createJob({ compositionId: "cmp_x", owner: "alice", revision: 1, config: {} });
  assert.equal(store.transitionJob(running.id, ["queued"], { status: "running" }), true);
  const queued = store.createJob({ compositionId: "cmp_y", owner: "alice", revision: 1, config: {} });
  store.close();

  const store2 = new McpStore(join(dir, "mcp.sqlite"), dir);
  const afterRunning = store2.getJob(running.id, "alice")!;
  assert.equal(afterRunning.status, "failed");
  assert.match(afterRunning.error ?? "", /WORKER_INTERRUPTED/);
  assert.equal(store2.getJob(queued.id, "alice")!.status, "queued");
  const renders = new RenderService(testConfig(), store2, () => null);
  try {
    await renders.start();
    const afterQueued = store2.getJob(queued.id, "alice")!;
    assert.equal(afterQueued.status, "failed");
    assert.match(afterQueued.error ?? "", /JOB_INTERRUPTED/);
    assert.equal(store2.listArtifacts("cmp_x", "alice").length, 0);
    assert.equal(store2.listArtifacts("cmp_y", "alice").length, 0);
  } finally { await renders.stop(); store2.close(); }
});
