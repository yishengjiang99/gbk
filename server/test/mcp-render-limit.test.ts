// Per-token-family daily render limit (mcp_oauth_tokens.daily_render_limit). Pure store + RenderService checks:
// no ffmpeg (ffmpeg is only reachable via seoRoutes' injected path, which these tests never mount), no shelling out,
// no rendering (widget jobs only create rows).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { testConfig } from "./helpers.ts";
import { McpStore, setFamilyRenderLimit } from "../src/mcp/store.ts";
import { RenderService, DEFAULT_RENDER_CONFIG } from "../src/mcp/browser-render.ts";
import type { CompositionRow } from "../src/mcp/store.ts";
import { parseLimit } from "../scripts/set-render-limit.ts";

const DAY = 86_400_000;
const row = (owner: string): CompositionRow => ({ id: `cmp_${owner}`, owner, title: "t", project_json: "{}", revision: 1, created_at: 0, updated_at: 0, visibility: "private", source: "mcp" });
const snap = {} as never;

function setup(env: Record<string, string> = {}) {
  const cfg = testConfig(env);
  const dir = mkdtempSync(join(tmpdir(), "gbk-mcp-limit-"));
  const store = new McpStore(join(dir, "mcp.sqlite"), dir);
  const renders = new RenderService(cfg, store, () => null);
  const token = (n: string, family: string, user: string) => store.putToken({ token: `gbk_at_${n}`, kind: "access", client_id: "c", user, scope: "gbk:renders.create", resource: "r", expires_at: Date.now() + DAY, family });
  const seed = (owner: string, n: number, family?: string) => { for (let i = 0; i < n; i++) store.createJob({ compositionId: `cmp_${owner}`, owner, revision: 1, config: {}, tokenFamily: family }); };
  const widget = (owner: string, family?: string) => renders.submitWidget(owner, row(owner), snap, { ...DEFAULT_RENDER_CONFIG }, undefined, family);
  const err = (f: () => unknown) => { try { f(); } catch (e) { return e as Error & { code?: string }; } assert.fail("expected QUOTA_EXCEEDED"); };
  return { cfg, dir, store, renders, token, seed, widget, err, done: async () => { await renders.stop(); store.close(); } };
}

test("custom family limit above the global 200 cap is honored, counted across the whole family", async () => {
  const s = setup();
  assert.equal(s.cfg.mcp.maxRendersPerDay, 200, "global default unchanged");
  s.token("a1", "svc-finalcap-6c53854a", "svc"); s.token("a2", "svc-finalcap-6c53854a", "svc");
  assert.deepEqual(s.store.setFamilyRenderLimit("svc-finalcap-6c53854a", 500), { families: ["svc-finalcap-6c53854a"], tokens: 2 });
  // Rotation within the family inherits the limit.
  s.token("a3", "svc-finalcap-6c53854a", "svc");
  assert.equal(s.store.getToken("gbk_at_a3")!.daily_render_limit, 500);
  s.seed("svc", 499, "svc-finalcap-6c53854a");
  assert.ok(s.widget("svc", "svc-finalcap-6c53854a").job, "render 500 allowed (above global 200)");
  assert.equal(s.err(() => s.widget("svc", "svc-finalcap-6c53854a")).code, "QUOTA_EXCEEDED");
  // A different family under a custom limit is counted on its own.
  s.token("b1", "fam_other", "svc"); s.store.setFamilyRenderLimit("fam_other", 3);
  assert.ok(s.widget("svc", "fam_other").job);
  await s.done();
});

test("null limit falls back to the global cap; untouched tokens keep the global cap", async () => {
  const s = setup({ MCP_MAX_RENDERS_PER_DAY: "5" });
  s.token("a1", "fam_x", "bob");
  s.store.setFamilyRenderLimit("fam_x", 50);
  s.store.setFamilyRenderLimit("fam_x", null);
  assert.equal(s.store.familyRenderLimit("fam_x"), null);
  s.seed("bob", 5);
  assert.match(s.err(() => s.widget("bob", "fam_x")).message, /5 renders per day/);
  s.token("c1", "fam_plain", "carol"); s.seed("carol", 5);
  assert.match(s.err(() => s.widget("carol", "fam_plain")).message, /5 renders per day/);
  await s.done();
});

test("family-limit error is the same friendly QUOTA_EXCEEDED as the global cap", async () => {
  const s = setup({ MCP_MAX_RENDERS_PER_DAY: "4" });
  s.seed("alice", 4);
  const global = s.err(() => s.widget("alice"));
  s.token("f1", "fam_lim", "dave"); s.store.setFamilyRenderLimit("fam_lim", 4); s.seed("dave", 4, "fam_lim");
  const fam = s.err(() => s.widget("dave", "fam_lim"));
  assert.equal(fam.code, global.code);
  assert.equal(fam.message, global.message);
  await s.done();
});

test("migration is idempotent and upgrades a pre-existing database", () => {
  const dir = mkdtempSync(join(tmpdir(), "gbk-mcp-mig-")), file = join(dir, "mcp.sqlite");
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE mcp_oauth_tokens (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, user TEXT NOT NULL,
      scope TEXT NOT NULL, resource TEXT NOT NULL, expires_at INTEGER NOT NULL, family TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE mcp_render_jobs (id TEXT PRIMARY KEY, composition_id TEXT NOT NULL, owner TEXT NOT NULL, revision INTEGER NOT NULL,
      status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0, config_json TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, finished_at INTEGER);
    INSERT INTO mcp_oauth_tokens VALUES ('h','access','c','u','s','r',0,'fam_old',0);`);
  McpStore.migrate(old); McpStore.migrate(old);
  const cols = (t: string) => (old.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  assert.equal(cols("mcp_oauth_tokens").filter((c) => c === "daily_render_limit").length, 1);
  assert.equal(cols("mcp_render_jobs").filter((c) => c === "token_family").length, 1);
  assert.equal((old.prepare("SELECT daily_render_limit AS n FROM mcp_oauth_tokens").get() as { n: unknown }).n, null, "existing rows default to NULL");
  // LIKE wildcards in a prefix are literal.
  assert.equal(setFamilyRenderLimit(old, "fam%", 9).tokens, 0);
  assert.equal(setFamilyRenderLimit(old, "fam_o", 9).tokens, 1);
  old.close();
  for (let i = 0; i < 2; i++) new McpStore(file, dir).close(); // full store open twice on the upgraded file
  assert.deepEqual([parseLimit("500"), parseLimit("null")], [500, null]);
  assert.throws(() => parseLimit("-1")); assert.throws(() => parseLimit("abc"));
});
