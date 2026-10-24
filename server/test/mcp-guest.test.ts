import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptModel, reply, testConfig } from "./helpers.ts";
import { startServer } from "./ws-helpers.ts";
import { McpClient } from "./mcp-helpers.ts";
import { McpStore } from "../src/mcp/store.ts";
import { guestCapability, resolveGuestCapability } from "../src/mcp/guest.ts";

const model = () => new ScriptModel([() => reply("unused")]);
const errorCode = (code: string) => (e: unknown) => (e as { payload?: { error?: { code?: string } } }).payload?.error?.code === code;
interface Guest { compositionId: string; revision: number; accessToken: string; readAccessToken: string; projectUrl: string }
const brief = { title: "Guest invention", style: "classical", bars: 4, seed: 5, idempotencyKey: "guest-create-1" };

test("guest lifecycle: private create, recovery in a new session, read-only access, edit, render, downloads and publish", async () => {
  const s = await startServer(model());
  try {
    const a = new McpClient(s.base); await a.initialize();
    const c = await a.call<Guest>("gbk_create_composition", brief);
    assert.ok(c.accessToken && c.readAccessToken && c.accessToken !== c.readAccessToken);
    assert.ok(!c.projectUrl.includes(c.accessToken));
    assert.equal(s.hub.registry.size, 0);
    const retry = await a.call<Guest>("gbk_create_composition", brief);
    assert.equal(retry.compositionId, c.compositionId); assert.equal(retry.accessToken, c.accessToken);
    const b = new McpClient(s.base); await b.initialize();
    const d = await b.call<Guest>("gbk_create_composition", brief);
    assert.notEqual(c.compositionId, d.compositionId, "same retry key in another session is not a credential");
    const args = { compositionId: c.compositionId, accessToken: c.accessToken };
    for (const who of [a, b]) {
      await assert.rejects(who.call("gbk_get_composition", { compositionId: c.compositionId }), errorCode("NOT_FOUND"));
      await assert.rejects(who.call("gbk_get_composition", { ...args, accessToken: d.accessToken }), errorCode("NOT_FOUND"));
      await assert.rejects(who.call("gbk_get_composition", { ...args, accessToken: c.accessToken + "x" }), errorCode("NOT_FOUND"));
      assert.deepEqual((await who.call<{ items: unknown[] }>("gbk_list_compositions")).items, []);
    }
    assert.equal((await b.call<Guest>("gbk_get_composition", { ...args, accessToken: c.readAccessToken })).compositionId, c.compositionId);
    for (const [tool, extra] of [
      ["gbk_edit_composition", { expectedRevision: c.revision, operations: [{ type: "set_tempo", bpm: 112 }] }],
      ["gbk_render_composition", {}], ["gbk_publish_composition", {}],
    ] as const) await assert.rejects(b.call(tool, { ...args, ...extra, accessToken: c.readAccessToken }), errorCode("INSUFFICIENT_SCOPE"));
    const edited = await b.call<Guest>("gbk_edit_composition", { ...args, expectedRevision: c.revision, operations: [{ type: "set_tempo", bpm: 112 }], idempotencyKey: "guest-edit-1" });
    assert.ok(edited.revision > c.revision);
    const link = await b.call<{ url: string; slug: string }>("gbk_open_workstation", args);
    assert.ok(link.url.includes(c.readAccessToken)); assert.ok(!link.url.includes(c.accessToken));
    assert.equal((await fetch(`${s.base}/api/shares/${link.slug}`)).status, 404);
    assert.equal((await fetch(`${s.base}/api/shares/${link.slug}`, { headers: { "x-gbk-project-token": d.readAccessToken } })).status, 404);
    assert.equal((await fetch(`${s.base}/api/shares/${link.slug}`, { headers: { "x-gbk-project-token": c.readAccessToken } })).status, 200);
    const r = await b.call<{ status: string; jobId: string }>("gbk_render_composition", { ...args, waitSeconds: 120, tailSeconds: 0 });
    assert.equal(r.status, "completed", JSON.stringify(r));
    assert.equal(s.hub.registry.size, 0, "audio rendered without a browser");
    await assert.rejects(a.call("gbk_get_render_status", { jobId: r.jobId, accessToken: d.accessToken }), errorCode("NOT_FOUND"));
    assert.equal((await a.call<{ status: string }>("gbk_get_render_status", { jobId: r.jobId, accessToken: c.readAccessToken })).status, "completed");
    const arts = await a.call<{ artifacts: { downloadUrl: string; sha256: string; kind: string }[] }>("gbk_get_artifacts", { ...args, accessToken: c.readAccessToken });
    assert.equal(arts.artifacts.length, 2);
    for (const artifact of arts.artifacts) {
      const url = new URL(artifact.downloadUrl);
      assert.equal((await fetch(s.base + url.pathname)).status, 401);
      const res = await fetch(s.base + url.pathname + url.search); assert.equal(res.status, 200);
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.equal(bytes.subarray(0, 4).toString(), artifact.kind === "wav" ? "RIFF" : "MThd");
      assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
    }
    const ui = await a.call<Record<string, unknown>>("gbk_show_composition_ui", { ...args, accessToken: c.readAccessToken });
    assert.ok(!JSON.stringify(ui).includes(c.accessToken));
    const published = await a.call<{ url: string; slug: string }>("gbk_publish_composition", args);
    assert.equal(new URL(published.url).hash, "");
    assert.equal((await fetch(`${s.base}/api/shares/${published.slug}`)).status, 200);
  } finally { await s.app.close(); }
});

test("global guest admission cannot be reset by opening a new session; retries do not charge twice", async () => {
  const s = await startServer(model(), { MCP_GUEST_CREATES_PER_DAY: "1" });
  try {
    const a = new McpClient(s.base); await a.initialize();
    const c = await a.call<Guest>("gbk_create_composition", brief);
    assert.equal((await a.call<Guest>("gbk_create_composition", brief)).compositionId, c.compositionId);
    const b = new McpClient(s.base); await b.initialize();
    await assert.rejects(b.call("gbk_create_composition", brief), errorCode("QUOTA_EXCEEDED"));
  } finally { await s.app.close(); }
});

test("guest size, revision, render quota and queue admission reject before publishing new state/jobs", async () => {
  const s = await startServer(model(), { MCP_GUEST_MAX_REVISIONS: "1", MCP_GUEST_RENDERS_PER_DAY: "1", MCP_MAX_QUEUE_DEPTH: "1" });
  try {
    const a = new McpClient(s.base); await a.initialize();
    await assert.rejects(a.call("gbk_create_composition", { ...brief, bars: 512 }), errorCode("QUOTA_EXCEEDED"));
    const c = await a.call<Guest>("gbk_create_composition", brief);
    const args = { compositionId: c.compositionId, accessToken: c.accessToken };
    await assert.rejects(a.call("gbk_edit_composition", { ...args, expectedRevision: c.revision, operations: [{ type: "set_tempo", bpm: 90 }] }), errorCode("QUOTA_EXCEEDED"));
    const owner = resolveGuestCapability(s.cfg, s.mcp.store, c.accessToken).user;
    const queued = s.mcp.store.createJob({ compositionId: c.compositionId, owner: "other", revision: c.revision, config: {} });
    await assert.rejects(a.call("gbk_render_composition", args), errorCode("QUOTA_EXCEEDED"));
    s.mcp.store.patchJob(queued.id, { status: "cancelled" });
    s.mcp.store.createJob({ compositionId: c.compositionId, owner, revision: c.revision, config: {} });
    await assert.rejects(a.call("gbk_render_composition", args), errorCode("QUOTA_EXCEEDED"));
    assert.equal(s.mcp.store.countJobsSince(owner, 86400000), 1);
  } finally { await s.app.close(); }
});

test("guest capabilities and quotas survive store restart; expired artifact bytes and metadata are deleted", () => {
  const dir = mkdtempSync(join(tmpdir(), "gbk-guest-"));
  const file = join(dir, "mcp.sqlite"); const cfg = testConfig();
  let store = new McpStore(file, dir);
  try {
    const row = store.createComposition({ owner: "guest:test", title: "Private", projectJson: "{}", revision: 0 });
    const token = guestCapability(cfg, row, "edit");
    assert.equal(store.takeGuestBudget("creates", 1), true);
    const art = store.addArtifact({ job_id: null, composition_id: row.id, owner: row.owner, revision: 0, kind: "midi", filename: "test.mid", mime_type: "audio/midi", size_bytes: 3, sha256: "unused", rel_path: "test.mid", meta_json: "{}" });
    const path = store.artifactAbsPath(art); writeFileSync(path, "abc");
    store.close(); store = new McpStore(file, dir);
    assert.equal(resolveGuestCapability(cfg, store, token).user, row.owner);
    assert.equal(store.takeGuestBudget("creates", 1), false);
    store.pruneArtifacts(0);
    assert.equal(existsSync(path), false); assert.equal(store.getArtifactAny(art.id), null);
    assert.equal(store.metrics().artifactBytes, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("simultaneous create retries return one project and capability", async () => {
  const s = await startServer(model(), { MCP_GUEST_CREATES_PER_DAY: "1" });
  try {
    const c = new McpClient(s.base); await c.initialize();
    const [a, b] = await Promise.all([c.call<Guest>("gbk_create_composition", brief), c.call<Guest>("gbk_create_composition", brief)]);
    assert.equal(a.compositionId, b.compositionId); assert.equal(a.accessToken, b.accessToken);
    assert.equal(s.mcp.store.guestCompositionCount(), 1);
  } finally { await s.app.close(); }
});

test("storage budgets reject guests even with fresh sessions; render admission respects disk capacity", async () => {
  const s = await startServer(model(), { MCP_GUEST_MAX_STORAGE_BYTES: "1", MCP_MAX_ARTIFACT_BYTES: "1" });
  try {
    const c = new McpClient(s.base); await c.initialize();
    await assert.rejects(c.call("gbk_create_composition", brief), errorCode("QUOTA_EXCEEDED"));
    assert.equal(s.mcp.store.guestCompositionCount(), 0);
    s.cfg.mcp.guestMaxStorageBytes = 256 * 1024 ** 2;
    const a = await c.call<Guest>("gbk_create_composition", brief);
    await assert.rejects(c.call("gbk_render_composition", { compositionId: a.compositionId, accessToken: a.accessToken }), errorCode("QUOTA_EXCEEDED"));
    assert.equal(s.mcp.store.queueDepth(), 0);
  } finally { await s.app.close(); }
});

test("in-process fallback obeys concurrency while queued work eventually starts", async () => {
  const { RenderService, DEFAULT_RENDER_CONFIG } = await import("../src/mcp/render.ts");
  const { WorkstationController } = await import("../../src/workstation/controller.ts");
  const dir = mkdtempSync(join(tmpdir(), "gbk-render-bound-"));
  const store = new McpStore(":memory:", dir);
  const cfg = testConfig({ MCP_RENDER_CONCURRENCY: "1" });
  const renders = new RenderService(cfg, store); renders.executor = "inprocess";
  const pending: (() => void)[] = [];
  let running = 0, peak = 0;
  // Control renderer completion to exercise admission/scheduling without timing races.
  (renders as unknown as { runInProcess: (job: { jobId: string }) => Promise<void> }).runInProcess = (job) => {
    running++; peak = Math.max(peak, running);
    return new Promise<void>((resolve) => pending.push(() => {
      running--; store.patchJob(job.jobId, { status: "completed" }); resolve();
    }));
  };
  try {
    const project = new WorkstationController().project;
    const row = store.createComposition({ owner: "alice", title: "Queue", projectJson: JSON.stringify(project), revision: project.revision });
    renders.submit("alice", row, project, DEFAULT_RENDER_CONFIG);
    renders.submit("alice", row, project, DEFAULT_RENDER_CONFIG);
    assert.equal(pending.length, 1); assert.equal(running, 1);
    pending.shift()!(); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pending.length, 1); assert.equal(running, 1); assert.equal(peak, 1);
    pending.shift()!(); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.queueDepth(), 0);
  } finally { await renders.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("guest can cancel while a status call is waiting in the same MCP session", async () => {
  const s = await startServer(model());
  try {
    const c = new McpClient(s.base); await c.initialize();
    const a = await c.call<Guest>("gbk_create_composition", brief);
    const owner = resolveGuestCapability(s.cfg, s.mcp.store, a.accessToken).user;
    const job = s.mcp.store.createJob({ compositionId: a.compositionId, owner, revision: a.revision, config: {} });
    const args = { jobId: job.id, accessToken: a.accessToken };
    const [status, cancelled] = await Promise.all([
      c.call<{ status: string }>("gbk_get_render_status", { ...args, waitSeconds: 2 }),
      c.call<{ status: string }>("gbk_cancel_render", args),
    ]);
    assert.equal(status.status, "cancelled"); assert.equal(cancelled.status, "cancelled");
    await assert.rejects(c.call("gbk_get_render_status", { jobId: job.id }), errorCode("NOT_FOUND"));
  } finally { await s.app.close(); }
});
