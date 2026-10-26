// Account-free ("guest") MCP projects: capability isolation, read-only capability, the SERVER_RENDER=0 browser
// handoff (server rendering itself: mcp-server-render.test.ts), durable guest budgets, and restart recovery.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, existsSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptModel, reply, testConfig } from "./helpers.ts";
import { startServer } from "./ws-helpers.ts";
import { McpClient } from "./mcp-helpers.ts";
import { McpStore } from "../src/mcp/store.ts";
import { guestCapability, resolveGuestCapability } from "../src/mcp/guest.ts";

const model = () => new ScriptModel([() => reply("unused")]);
const errorCode = (code: string) => (e: unknown) => JSON.stringify(e).includes(code) || String((e as Error)?.message ?? "").includes(code);
interface Guest { compositionId: string; revision: number; accessToken: string; readAccessToken: string; projectUrl: string }
const brief = { title: "Guest invention", style: "classical", bars: 4, seed: 5, idempotencyKey: "guest-create-1" };

/** Any OfflineAudioContext construction on the server during the block is a test failure. */
async function forbidServerSynthesis<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as { OfflineAudioContext?: unknown; AudioContext?: unknown };
  const saved = { o: g.OfflineAudioContext, a: g.AudioContext };
  let constructed = 0;
  const trap = class { constructor() { constructed++; throw new Error("server synthesis attempted"); } };
  g.OfflineAudioContext = trap; g.AudioContext = trap;
  try { const out = await fn(); assert.equal(constructed, 0, "the server must never construct an audio context"); return out; }
  finally { g.OfflineAudioContext = saved.o; g.AudioContext = saved.a; }
}

test("guest lifecycle: create without login, edit with capability in a new session, MIDI + browser render handoff, ID alone grants nothing", async () => {
  const s = await startServer(model(), { SERVER_RENDER: "0" });
  try {
    await forbidServerSynthesis(async () => {
      const a = new McpClient(s.base); await a.initialize();
      const c = await a.call<Guest>("gbk_create_composition", brief);
      assert.ok(c.compositionId && c.accessToken && c.readAccessToken && c.accessToken !== c.readAccessToken);
      assert.ok(!c.projectUrl.includes(c.accessToken), "edit capability never in a URL");
      assert.equal(new URL(c.projectUrl).hash, `#access=${c.readAccessToken}`, "Studio link carries only the read capability, in the fragment");
      const retry = await a.call<Guest>("gbk_create_composition", brief);
      assert.equal(retry.compositionId, c.compositionId, "same-session retry is idempotent");

      const b = new McpClient(s.base); await b.initialize();
      const d = await b.call<Guest>("gbk_create_composition", brief);
      assert.notEqual(d.compositionId, c.compositionId, "a retry key replayed in another session is not a credential");
      const args = { compositionId: c.compositionId, accessToken: c.accessToken };

      // Isolation: ID alone, another project's token, or a tampered token -> NOT_FOUND. No directory.
      for (const who of [a, b]) {
        await assert.rejects(who.call("gbk_get_composition", { compositionId: c.compositionId }), errorCode("NOT_FOUND"));
        await assert.rejects(who.call("gbk_get_composition", { ...args, accessToken: d.accessToken }), errorCode("NOT_FOUND"));
        await assert.rejects(who.call("gbk_get_composition", { ...args, accessToken: c.accessToken.slice(0, -2) + "xx" }), errorCode("NOT_FOUND"));
        await assert.rejects(who.call("gbk_get_artifacts", { compositionId: c.compositionId }), errorCode("NOT_FOUND"));
        assert.deepEqual((await who.call<{ items: unknown[] }>("gbk_list_compositions")).items, []);
      }

      // Read capability: can read, cannot edit / render / publish.
      assert.equal((await b.call<Guest>("gbk_get_composition", { ...args, accessToken: c.readAccessToken })).compositionId, c.compositionId);
      for (const [tool, extra] of [
        ["gbk_edit_composition", { expectedRevision: c.revision, operations: [{ type: "set_tempo", bpm: 112 }] }],
        ["gbk_render_composition", {}], ["gbk_publish_composition", {}],
      ] as const) await assert.rejects(b.call(tool, { ...args, ...extra, accessToken: c.readAccessToken }), errorCode("INSUFFICIENT_SCOPE"));

      // Edit from a different session with the edit capability.
      const edited = await b.call<Guest>("gbk_edit_composition", { ...args, expectedRevision: c.revision, operations: [{ type: "set_tempo", bpm: 112 }], idempotencyKey: "guest-edit-1" });
      assert.ok(edited.revision > c.revision);

      // Render: MIDI from the server, audio handed to the browser. No WAV, no Studio tab needed.
      const r = await b.call<{ status: string; jobId: string; artifacts: { kind: string; downloadUrl: string; sha256: string }[]; browserRender: Record<string, string> }>("gbk_render_composition", { ...args, waitSeconds: 5 });
      assert.equal(r.status, "browser_render");
      assert.deepEqual(r.artifacts.map((x) => x.kind), ["midi"], "the server publishes MIDI only");
      assert.equal(r.browserRender.widgetTool, "gbk_show_composition_ui");
      assert.equal(r.browserRender.readAccessToken, c.readAccessToken);
      assert.ok(!JSON.stringify(r).includes(c.accessToken), "render result never echoes the edit capability");
      assert.equal(s.hub.registry.size, 0, "no browser bridge involved");
      const mid = new URL(r.artifacts[0].downloadUrl);
      const res = await fetch(s.base + mid.pathname + mid.search); assert.equal(res.status, 200);
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.equal(bytes.subarray(0, 4).toString(), "MThd");
      assert.equal(createHash("sha256").update(bytes).digest("hex"), r.artifacts[0].sha256);

      // Job status needs the project capability too.
      await assert.rejects(a.call("gbk_get_render_status", { jobId: r.jobId }), errorCode("NOT_FOUND"));
      await assert.rejects(a.call("gbk_get_render_status", { jobId: r.jobId, accessToken: d.accessToken }), errorCode("NOT_FOUND"));
      assert.equal((await a.call<{ status: string }>("gbk_get_render_status", { jobId: r.jobId, accessToken: c.readAccessToken })).status, "completed");

      // Browser render snapshot: read capability only, exact latest revision.
      assert.equal((await fetch(`${s.base}/api/mcp/guest/snapshot`)).status, 404);
      const other = await (await fetch(`${s.base}/api/mcp/guest/snapshot`, { headers: { "x-gbk-project-token": d.readAccessToken } })).json() as { compositionId: string };
      assert.equal(other.compositionId, d.compositionId, "a token only ever opens its own project");
      const snap = await (await fetch(`${s.base}/api/mcp/guest/snapshot`, { headers: { "x-gbk-project-token": c.readAccessToken } })).json() as { revision: number; project: { notes: unknown[] } };
      assert.equal(snap.revision, edited.revision); assert.ok(snap.project.notes.length > 0);

      // Player widget output: browser render handoff, no edit capability.
      const ui = await a.call<Record<string, unknown>>("gbk_show_composition_ui", { ...args, accessToken: c.readAccessToken });
      assert.ok(ui.browserRender); assert.ok(!JSON.stringify(ui).includes(c.accessToken));

      // Private Studio link: the share is readable only with this project's read capability.
      const link = await b.call<{ url: string; slug: string }>("gbk_open_workstation", args);
      assert.ok(link.url.includes(c.readAccessToken) && !link.url.includes(c.accessToken));
      assert.equal((await fetch(`${s.base}/api/shares/${link.slug}`)).status, 404);
      assert.equal((await fetch(`${s.base}/api/shares/${link.slug}`, { headers: { "x-gbk-project-token": d.readAccessToken } })).status, 404);
      assert.equal((await fetch(`${s.base}/api/shares/${link.slug}`, { headers: { "x-gbk-project-token": c.readAccessToken } })).status, 200);

      // Publish (explicit) strips every capability from the public URL.
      const pub = await a.call<{ url: string; slug: string }>("gbk_publish_composition", args);
      assert.equal(new URL(pub.url).hash, "");
      assert.equal((await fetch(`${s.base}/api/shares/${pub.slug}`)).status, 200);
    });
  } finally { await s.app.close(); }
});

test("server synthesis is confined to the render worker thread; SERVER_RENDER=0 never produces a WAV", async () => {
  const root = new URL("../src/", import.meta.url).pathname;
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|mjs|js)$/.test(f)) files.push(p); } };
  walk(root);
  // Synthesis modules may only be imported by the worker entry; the main thread never constructs an audio context.
  const banned = /(from|import|require\()\s*\(?["'][^"']*(offline-renderer|sf2-renderer|sf2-processor|offline-audio-context|node-offline-env|synth-engine)[^"']*["']|new\s+(Offline)?AudioContext\b|renderProjectOffline\(/;
  for (const f of files) if (!f.endsWith("/mcp/render-worker.ts")) {
    const src = readFileSync(f, "utf8").replace(/^import type .*$/gm, "");
    assert.doesNotMatch(src, banned, `${f} must not synthesize on the main thread (use the render worker)`);
  }
  const s = await startServer(model(), { SERVER_RENDER: "0" });
  try {
    await forbidServerSynthesis(async () => {
      const c = new McpClient(s.base); await c.initialize();
      const g = await c.call<Guest>("gbk_create_composition", { ...brief, idempotencyKey: undefined });
      await c.call("gbk_render_composition", { compositionId: g.compositionId, accessToken: g.accessToken, waitSeconds: 2 });
      const arts = await c.call<{ artifacts: { kind: string }[] }>("gbk_get_artifacts", { compositionId: g.compositionId, accessToken: g.accessToken });
      assert.ok(arts.artifacts.length >= 1 && arts.artifacts.every((x) => x.kind !== "wav"));
      assert.equal(s.mcp.store.metrics().jobsActive, 0);
    });
  } finally { await s.app.close(); }
});

test("global guest create budget cannot be reset by a new session; same-session retries do not charge twice", async () => {
  const s = await startServer(model(), { MCP_GUEST_CREATES_PER_DAY: "1" });
  try {
    const a = new McpClient(s.base); await a.initialize();
    const c = await a.call<Guest>("gbk_create_composition", brief);
    assert.equal((await a.call<Guest>("gbk_create_composition", brief)).compositionId, c.compositionId);
    const b = new McpClient(s.base); await b.initialize();
    await assert.rejects(b.call("gbk_create_composition", brief), errorCode("QUOTA_EXCEEDED"));
  } finally { await s.app.close(); }
});

test("guest size, revision, per-project render, storage and composition caps reject before persisting", async () => {
  const s = await startServer(model(), { SERVER_RENDER: "0", MCP_GUEST_MAX_REVISIONS: "1", MCP_GUEST_RENDERS_PER_DAY: "1" });
  try {
    const a = new McpClient(s.base); await a.initialize();
    await assert.rejects(a.call("gbk_create_composition", { ...brief, bars: 512 }), errorCode("QUOTA_EXCEEDED"));
    assert.equal(s.mcp.store.guestCompositionCount(), 0);
    const c = await a.call<Guest>("gbk_create_composition", brief);
    const args = { compositionId: c.compositionId, accessToken: c.accessToken };
    await assert.rejects(a.call("gbk_edit_composition", { ...args, expectedRevision: c.revision, operations: [{ type: "set_tempo", bpm: 90 }] }), errorCode("QUOTA_EXCEEDED"));
    await a.call("gbk_render_composition", args);
    await assert.rejects(a.call("gbk_render_composition", args), errorCode("QUOTA_EXCEEDED"));
    s.cfg.mcp.guestMaxStorageBytes = 1;
    await assert.rejects(a.call("gbk_create_composition", { ...brief, idempotencyKey: "guest-create-2" }), errorCode("QUOTA_EXCEEDED"));
    s.cfg.mcp.guestMaxStorageBytes = 256 * 1024 ** 2; s.cfg.mcp.guestMaxProjectBytes = 1; // per-project cap (renders included)
    await assert.rejects(a.call("gbk_create_composition", { ...brief, idempotencyKey: "guest-create-2b" }), errorCode("QUOTA_EXCEEDED"));
    s.cfg.mcp.guestMaxProjectBytes = 64 * 1024 ** 2;
    s.cfg.mcp.guestMaxStorageBytes = 256 * 1024 ** 2; s.cfg.mcp.guestMaxCompositions = 1;
    await assert.rejects(a.call("gbk_create_composition", { ...brief, idempotencyKey: "guest-create-3" }), errorCode("QUOTA_EXCEEDED"));
    assert.equal(s.mcp.store.guestCompositionCount(), 1);
  } finally { await s.app.close(); }
});

test("anonymous tool calls are IP-throttled; the off switch restores OAuth-only access", async () => {
  const s = await startServer(model(), { MCP_GUEST_CALLS_PER_MINUTE: "2" });
  try {
    const a = new McpClient(s.base); await a.initialize();
    await a.callRaw("gbk_list_compositions"); await a.callRaw("gbk_list_compositions");
    assert.equal((await a.callRaw("gbk_list_compositions")).status, 429);
  } finally { await s.app.close(); }
  const off = await startServer(model(), { MCP_GUEST: "0" });
  try {
    const a = new McpClient(off.base); await a.initialize();
    const r = await a.callRaw("gbk_create_composition", { title: "x" });
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") ?? "", /oauth-protected-resource/);
  } finally { await off.app.close(); }
});

test("guest capabilities and budgets survive a store restart; expired artifact bytes and rows are deleted", () => {
  const dir = mkdtempSync(join(tmpdir(), "gbk-guest-"));
  const file = join(dir, "mcp.sqlite"); const cfg = testConfig();
  let store = new McpStore(file, dir);
  try {
    const row = store.createComposition({ owner: "guest:test", title: "Private", projectJson: "{}", revision: 0 });
    const token = guestCapability(cfg, row, "edit");
    assert.equal(store.takeGuestBudget("creates", 1), true);
    const art = store.addArtifact({ job_id: null, composition_id: row.id, owner: row.owner, revision: 0, kind: "midi", filename: "t.mid", mime_type: "audio/midi", size_bytes: 3, sha256: "x", rel_path: "t.mid", meta_json: "{}" });
    const path = store.artifactAbsPath(art); writeFileSync(path, "abc");
    store.close(); store = new McpStore(file, dir);
    assert.equal(resolveGuestCapability(cfg, store, token).user, row.owner);
    assert.equal(resolveGuestCapability(cfg, store, guestCapability(cfg, row, "read")).scopes.includes("gbk:compositions.write"), false);
    assert.equal(store.takeGuestBudget("creates", 1), false, "budget persisted across restart");
    assert.throws(() => resolveGuestCapability(testConfig({ SESSION_SECRET: "another-secret-another-secret-123456" }), store, token), /NOT_FOUND|invalid/);
    assert.equal(store.pruneArtifacts(0), 1);
    assert.equal(existsSync(path), false); assert.equal(store.getArtifactAny(art.id), null);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("guest delete needs the edit capability and removes everything; claim moves a project into a signed-in account", async () => {
  const s = await startServer(model(), { MCP_TEST_AUTH: "1" });
  try {
    const anon = new McpClient(s.base); await anon.initialize();
    const g = await anon.call<Guest>("gbk_create_composition", { ...brief, idempotencyKey: undefined });
    const args = { compositionId: g.compositionId, accessToken: g.accessToken };
    const r = await anon.call<{ artifacts: { downloadUrl: string }[] }>("gbk_render_composition", args);
    await assert.rejects(anon.call("gbk_delete_composition", { compositionId: g.compositionId }), errorCode("NOT_FOUND"));
    await assert.rejects(anon.call("gbk_delete_composition", { ...args, accessToken: g.readAccessToken }), errorCode("INSUFFICIENT_SCOPE"));
    assert.deepEqual(await anon.call("gbk_delete_composition", args), { deleted: true, compositionId: g.compositionId });
    await assert.rejects(anon.call("gbk_get_composition", args), errorCode("NOT_FOUND"));
    const u = new URL(r.artifacts[0].downloadUrl);
    assert.equal((await fetch(s.base + u.pathname + u.search)).status, 404, "artifact rows + bytes gone");
    assert.equal(s.mcp.store.guestCompositionCount(), 0);

    // Claim: anonymous session cannot claim; a signed-in session with the edit token can.
    const h = await anon.call<Guest>("gbk_create_composition", { ...brief, idempotencyKey: undefined });
    const hargs = { compositionId: h.compositionId, accessToken: h.accessToken };
    await assert.rejects(anon.call("gbk_claim_composition", hargs), errorCode("UNAUTHENTICATED"));
    const alice = new McpClient(s.base, { "x-gbk-test-user": "alice" }); await alice.initialize();
    await assert.rejects(alice.call("gbk_claim_composition", { ...hargs, accessToken: h.readAccessToken }), errorCode("INSUFFICIENT_SCOPE"));
    const claimed = await alice.call<{ claimed: boolean; compositionId: string }>("gbk_claim_composition", hargs);
    assert.equal(claimed.claimed, true);
    assert.equal((await alice.call<{ compositionId: string }>("gbk_get_composition", { compositionId: h.compositionId })).compositionId, h.compositionId, "now in alice's library without a token");
    await assert.rejects(anon.call("gbk_get_composition", hargs), errorCode("NOT_FOUND"), "old capability no longer works");
    const bob = new McpClient(s.base, { "x-gbk-test-user": "bob" }); await bob.initialize();
    await assert.rejects(bob.call("gbk_get_composition", { compositionId: h.compositionId }), errorCode("NOT_FOUND"));
  } finally { await s.app.close(); }
});

test("DoS: one client cannot drain the global create budget; per-client cap trips first, other clients keep working", async () => {
  const s = await startServer(model(), { MCP_GUEST_CREATES_PER_CLIENT_PER_DAY: "2", MCP_GUEST_CREATES_PER_DAY: "5" });
  try {
    // Fresh sessions from the same client do not reset the per-client cap.
    for (let i = 0; i < 2; i++) { const c = new McpClient(s.base); await c.initialize(); await c.call("gbk_create_composition", { ...brief, idempotencyKey: undefined }); }
    const c3 = new McpClient(s.base); await c3.initialize();
    await assert.rejects(c3.call("gbk_create_composition", { ...brief, idempotencyKey: undefined }), errorCode("for this network"));
    // The global budget was not consumed by the rejected attempts: another client (simulated by a new key) still has room.
    assert.equal(s.mcp.store.takeGuestBudget("creates:another-client", 2), true);
    assert.equal(s.mcp.store.takeGuestBudget("creates", 5), true, "global budget still has capacity after one client hit its cap");
  } finally { await s.app.close(); }
});
