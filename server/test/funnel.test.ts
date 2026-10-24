// Funnel analytics: aggregate daily counters only, no identifiers; admin-only read; MCP steps counted.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer, login } from "./ws-helpers.ts";
import { McpClient } from "./mcp-helpers.ts";
import { FunnelStore } from "../src/persistence/funnel.ts";

const model = () => new ScriptModel([() => reply("unused")]);

test("funnel store keeps only (day, event, source, count); unknown events are dropped", () => {
  const dir = mkdtempSync(join(tmpdir(), "gbk-funnel-")); const f = join(dir, "a.sqlite");
  try {
    const s = new FunnelStore(f);
    s.bump("create", "guest"); s.bump("create", "guest"); s.bump("mcp_connect", "guest");
    s.bump("nope" as never); s.bump("create", "1.2.3.4" as never);
    const sum = s.summary(7);
    assert.equal(sum.totals.create, 2); assert.equal(sum.bySource.create.guest, 2); assert.equal(sum.conversion.createPerConnect, 2);
    s.close();
    const db = new DatabaseSync(f, { readOnly: true });
    const cols = (db.prepare("PRAGMA table_info(funnel_daily)").all() as { name: string }[]).map((c) => c.name);
    assert.deepEqual(cols, ["day", "event", "source", "count"], "no identifying columns");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM funnel_daily").get() as { n: number }).n, 2);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP connect/create/edit/render/download/delete and pages are counted; beacon allow-list; admin-only endpoint", async () => {
  const s = await startServer(model(), { COMPOSER_ACCESS_CODES: "owner:code-owner,bob:code-bob", COMPOSER_ADMIN_USERS: "owner" });
  try {
    const c = new McpClient(s.base); await c.initialize();
    const g = await c.call<{ compositionId: string; revision: number; accessToken: string }>("gbk_create_composition", { title: "Funnel", bars: 4 });
    const t = { compositionId: g.compositionId, accessToken: g.accessToken };
    await c.call("gbk_edit_composition", { ...t, expectedRevision: g.revision, operations: [{ type: "set_tempo", bpm: 100 }] });
    const r = await c.call<{ artifacts: { kind: string; downloadUrl: string }[] }>("gbk_render_composition", t);
    const u = new URL(r.artifacts.find((a) => a.kind === "midi")!.downloadUrl); await (await fetch(s.base + u.pathname + u.search)).arrayBuffer();
    await c.call("gbk_delete_composition", t);
    await (await fetch(`${s.base}/chatgpt`)).text(); await (await fetch(`${s.base}/privacy`)).text();
    assert.equal((await fetch(`${s.base}/api/funnel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "browser_render_completed", source: "studio" }) })).status, 204);
    assert.equal((await fetch(`${s.base}/api/funnel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "browser_render_completed", source: "widget" }) })).status, 400, "widget renders are counted server-side on gbk_widget_render_finish");
    assert.equal((await fetch(`${s.base}/api/funnel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "create", source: "guest" }) })).status, 400, "server-side events cannot be forged");

    assert.equal((await fetch(`${s.base}/api/admin/funnel`)).status, 401);
    const bob = await login(s.base, "code-bob");
    assert.equal((await fetch(`${s.base}/api/admin/funnel`, { headers: { cookie: bob.cookie } })).status, 403);
    const owner = await login(s.base, "code-owner");
    const sum = await (await fetch(`${s.base}/api/admin/funnel?days=7`, { headers: { cookie: owner.cookie } })).json() as { totals: Record<string, number>; bySource: Record<string, Record<string, number>> };
    for (const [k, v] of Object.entries({ mcp_connect: 1, create: 1, edit: 1, render_requested: 1, midi_download: 1, delete: 1, page_view_chatgpt: 1, page_view_legal: 1, browser_render_completed: 1 })) assert.equal(sum.totals[k], v, k);
    assert.equal(sum.bySource.create.guest, 1);
    assert.doesNotMatch(JSON.stringify(sum), /cmp_|127\.0\.0\.1|Funnel/, "no ids, IPs or content in analytics");
  } finally { await s.app.close(); }
});
