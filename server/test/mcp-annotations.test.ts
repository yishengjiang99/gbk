// ChatGPT directory review: explicit hints, output schemas, widget/auth metadata, and the behaviors the hints describe.
// Everything runs against an in-memory app; nothing touches production data.
import test from "node:test";
import assert from "node:assert/strict";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer } from "./ws-helpers.ts";
import { McpClient } from "./mcp-helpers.ts";
import { TOOL_HINTS } from "../src/mcp/tool-meta.ts";

const model = () => new ScriptModel([() => reply("x")]);
const failsWith = (code: string) => (e: unknown) => String((e as Error).message).includes(code);
type Tool = { name: string; annotations: Record<string, unknown>; outputSchema?: { type: string; properties: Record<string, unknown> }; _meta?: Record<string, unknown> };
interface Comp { compositionId: string; revision: number; revisions: unknown[]; accessToken: string }

test("tools/list: all four hints are explicit and match tool-meta; every tool has an outputSchema and securitySchemes; widget domain + CSP", async () => {
  const s = await startServer(model(), { MCP_TEST_AUTH: "1" });
  try {
    const c = new McpClient(s.base); await c.initialize();
    const tools = ((await c.send("tools/list", {})).rpc?.result as { tools: Tool[] }).tools;
    assert.equal(tools.length, 17);
    assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(TOOL_HINTS).sort());
    for (const t of tools) {
      for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) assert.equal(typeof t.annotations[k], "boolean", `${t.name}.${k}`);
      assert.deepEqual(t.annotations, { ...TOOL_HINTS[t.name].hints, ...(t.annotations.title ? { title: t.annotations.title } : {}) }, t.name);
      assert.equal(t.outputSchema?.type, "object", `${t.name} outputSchema`);
      assert.ok(Array.isArray(t._meta?.securitySchemes) && (t._meta!.securitySchemes as unknown[]).length, `${t.name} securitySchemes`);
      assert.ok(TOOL_HINTS[t.name].why.length > 40, `${t.name} justification`);
    }
    const hint = (n: string) => tools.find((t) => t.name === n)!.annotations;
    for (const n of ["gbk_open_workstation", "gbk_show_composition_ui"]) assert.deepEqual([hint(n).readOnlyHint, hint(n).destructiveHint, hint(n).openWorldHint], [false, true, true], n);
    assert.equal(hint("gbk_edit_composition").destructiveHint, true);
    assert.equal(hint("gbk_delete_composition").openWorldHint, true);
    assert.equal(hint("gbk_widget_render_finish").destructiveHint, true);
    assert.deepEqual(tools.find((t) => t.name === "gbk_claim_composition")!._meta!.securitySchemes, [{ type: "oauth2", scopes: ["gbk:compositions.write"] }]);

    const ui = (await c.send("resources/read", { uri: "ui://gbk/composer-v2.html" })).rpc?.result as { contents: { _meta: Record<string, any> }[] };
    const meta = ui.contents[0]._meta;
    assert.equal(meta.ui.domain, "http://composer.test"); assert.equal(meta["openai/widgetDomain"], "http://composer.test");
    assert.deepEqual(meta["openai/widgetCSP"].connect_domains, ["http://composer.test"]);
  } finally { await s.app.close(); }
});

test("open/show overwrite an already-public share; repeat open is stable; delete removes the public share and repeats as NOT_FOUND", async () => {
  const s = await startServer(model(), { MCP_TEST_AUTH: "1", SERVER_RENDER: "0" });
  try {
    const g = new McpClient(s.base); await g.initialize();
    const c = await g.call<Comp>("gbk_create_composition", { title: "Annot guest", style: "classical", bars: 4, seed: 3 });
    const args = { compositionId: c.compositionId, accessToken: c.accessToken };
    const pub = await g.call<{ slug: string }>("gbk_publish_composition", args);
    assert.equal(s.shares.bySlug(pub.slug)!.public, 1);
    const ed = await g.call<Comp>("gbk_edit_composition", { ...args, expectedRevision: c.revision, operations: [{ type: "set_tempo", bpm: 77 }] });
    const before = s.shares.bySlug(pub.slug)!.project_json;
    const o1 = await g.call<{ slug: string }>("gbk_open_workstation", args);
    const after = s.shares.bySlug(o1.slug)!;
    assert.equal(after.public, 1, "still public"); assert.notEqual(after.project_json, before, "public content overwritten by open");
    assert.equal(JSON.parse(after.project_json).revision, ed.revision);
    const o2 = await g.call<{ slug: string }>("gbk_open_workstation", args);
    assert.equal(o2.slug, o1.slug); assert.equal(s.shares.bySlug(o2.slug)!.project_json, after.project_json, "repeat open: same link, same content");
    await g.call<Comp>("gbk_edit_composition", { ...args, expectedRevision: ed.revision, operations: [{ type: "set_tempo", bpm: 88 }] });
    await g.call("gbk_show_composition_ui", args);
    assert.notEqual(s.shares.bySlug(o1.slug)!.project_json, after.project_json, "show_composition_ui overwrites the public snapshot too");

    assert.deepEqual(await g.call("gbk_delete_composition", args), { deleted: true, compositionId: c.compositionId });
    assert.ok(!s.shares.bySlug(pub.slug), "public share removed");
    await assert.rejects(g.call("gbk_delete_composition", args), failsWith("NOT_FOUND"));
  } finally { await s.app.close(); }
});

test("account edits prune revisions past the plan limit; a stale repeat edit is rejected", async () => {
  const s = await startServer(model(), { MCP_TEST_AUTH: "1", TIER_FREE_REVISIONS: "2" });
  try {
    const a = new McpClient(s.base, { "x-gbk-test-user": "annot-alice" }); await a.initialize();
    const c = await a.call<Comp>("gbk_create_composition", { title: "Annot prune", style: "classical", bars: 4, seed: 4 });
    let rev = c.revision;
    for (const bpm of [70, 80, 90]) rev = (await a.call<Comp>("gbk_edit_composition", { compositionId: c.compositionId, expectedRevision: rev, operations: [{ type: "set_tempo", bpm }] })).revision;
    const got = await a.call<Comp>("gbk_get_composition", { compositionId: c.compositionId });
    assert.equal(got.revisions.length, 2, "older snapshots permanently deleted");
    await assert.rejects(a.call("gbk_edit_composition", { compositionId: c.compositionId, expectedRevision: c.revision, operations: [{ type: "set_tempo", bpm: 70 }] }), failsWith("STALE_REVISION"));
  } finally { await s.app.close(); }
});

test("widget render: stop discards the job (failed, no artifacts); finish and cancel repeat without further effect", async () => {
  const s = await startServer(model(), { MCP_TEST_AUTH: "1", SERVER_RENDER: "0" });
  try {
    const g = new McpClient(s.base); await g.initialize();
    const c = await g.call<Comp>("gbk_create_composition", { title: "Annot render", style: "classical", bars: 4, seed: 5 });
    const args = { compositionId: c.compositionId, accessToken: c.accessToken };
    const st = await g.call<{ jobId: string; token: string }>("gbk_widget_render_start", args);
    const stop = { accessToken: c.accessToken, jobId: st.jobId, token: st.token, ok: false, errorCode: "OPERATION_CANCELLED" };
    const fin = await g.call<{ status: string; artifacts: unknown[]; error: { code: string } }>("gbk_widget_render_finish", stop);
    assert.equal(fin.status, "failed"); assert.equal(fin.error.code, "OPERATION_CANCELLED"); assert.deepEqual(fin.artifacts, []);
    await assert.rejects(g.call("gbk_widget_render_finish", stop), failsWith("NOT_FOUND"));
    const c1 = await g.call<{ status: string }>("gbk_cancel_render", { accessToken: c.accessToken, jobId: st.jobId });
    const c2 = await g.call<{ status: string }>("gbk_cancel_render", { accessToken: c.accessToken, jobId: st.jobId });
    assert.equal(c1.status, "failed"); assert.deepEqual(c2, c1, "cancel on a terminal job changes nothing");
    const arts = await g.call<{ artifacts: unknown[] }>("gbk_get_artifacts", args);
    assert.deepEqual(arts.artifacts.filter((x) => (x as { kind: string }).kind === "wav"), [], "no WAV from a stopped render");
  } finally { await s.app.close(); }
});
