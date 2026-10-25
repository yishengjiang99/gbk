// Phase 6 launch counters: first successful tool call (once per MCP session), server vs browser render
// completion, render failures, gallery views, install CTA clicks and the "no listing URL" state. Aggregate only.
import test from "node:test";
import assert from "node:assert/strict";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer, login } from "./ws-helpers.ts";
import { McpClient } from "./mcp-helpers.ts";

const model = () => new ScriptModel([() => reply("unused")]);
const summary = async (base: string) => { const o = await login(base, "code-owner"); return await (await fetch(`${base}/api/admin/funnel?days=2`, { headers: { cookie: o.cookie } })).json() as { totals: Record<string, number>; bySource: Record<string, Record<string, number>>; conversion: Record<string, number | null> }; };

test("first_tool_call once per session; server render completion counted as server; gallery + no-listing states", async () => {
  const s = await startServer(model(), { COMPOSER_ACCESS_CODES: "owner:code-owner", COMPOSER_ADMIN_USERS: "owner" });
  try {
    const c = new McpClient(s.base); await c.initialize();
    const g = await c.call<{ compositionId: string; accessToken: string }>("gbk_create_composition", { title: "F", bars: 2 });
    await c.call("gbk_get_composition", { compositionId: g.compositionId, accessToken: g.accessToken });
    const r = await c.call<{ status: string }>("gbk_render_composition", { compositionId: g.compositionId, accessToken: g.accessToken, waitSeconds: 60 });
    const c2 = new McpClient(s.base); await c2.initialize(); await c2.call("gbk_get_capabilities", {});
    await (await fetch(`${s.base}/chatgpt/gallery`)).text(); await (await fetch(`${s.base}/chatgpt`)).text();
    const inst = await fetch(`${s.base}/chatgpt/install`, { redirect: "manual" }); assert.equal(inst.status, 404);
    const sum = await summary(s.base);
    assert.equal(sum.totals.first_tool_call, 2, "one per MCP session, not per call");
    assert.equal(sum.bySource.first_tool_call?.guest, 1);
    if (r.status === "completed") { assert.equal(sum.totals.server_render_completed, 1); assert.equal(sum.bySource.server_render_completed?.server, 1); assert.equal(sum.totals.browser_render_completed, 0, "no double counting"); }
    assert.equal(sum.totals.page_view_gallery, 1);
    assert.equal(sum.totals.install_link_unavailable, 2, "landing view + install hit while no listing URL is set");
    assert.equal(sum.totals.install_cta_click, 0);
    assert.ok("firstToolCallPerConnect" in sum.conversion && "renderFailurePerRequest" in sum.conversion);
  } finally { await s.app.close(); }
});

test("install CTA goes through /chatgpt/install (302 + counted) only when CHATGPT_PLUGIN_URL is set", async () => {
  const s = await startServer(model(), { COMPOSER_ACCESS_CODES: "owner:code-owner", COMPOSER_ADMIN_USERS: "owner", CHATGPT_PLUGIN_URL: "https://chatgpt.com/apps/example" });
  try {
    const html = await (await fetch(`${s.base}/chatgpt`)).text();
    assert.ok(html.includes('href="/chatgpt/install"') && !html.includes("chatgpt.com/apps/example\""), "CTA points at the counting redirect");
    const r = await fetch(`${s.base}/chatgpt/install`, { redirect: "manual" });
    assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "https://chatgpt.com/apps/example");
    const sum = await summary(s.base);
    assert.equal(sum.totals.install_cta_click, 1); assert.equal(sum.totals.install_link_unavailable, 0);
  } finally { await s.app.close(); }
});
