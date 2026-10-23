import { test } from "node:test";
import assert from "node:assert/strict";
import { ShimModelContext, installGbkTools } from "../src/webmcp/shim.ts";
import { agentToolsMode, getModelContext } from "../src/webmcp/adapter.ts";

test("shim registry: register, list, call, abort-unregister", async () => {
  const mc = new ShimModelContext(); const ac = new AbortController();
  mc.registerTool({ name: "gbk_echo", description: "d", inputSchema: {}, execute: async (i) => JSON.stringify({ ok: true, data: i }) }, { signal: ac.signal });
  const scope: Record<string, any> = {};
  const api = installGbkTools("shim", mc, scope);
  assert.equal(scope.gbkTools, api); assert.equal(api.mode, "shim");
  assert.deepEqual((await api.list()).map((t) => t.name), ["gbk_echo"]);
  assert.deepEqual(JSON.parse(await api.call("gbk_echo", { x: 1 }) as string), { ok: true, data: { x: 1 } });
  ac.abort();
  assert.equal((await api.list()).length, 0);
  await assert.rejects(api.call("gbk_echo"), /not registered/);
});

test("mode detection prefers the real API", () => {
  assert.equal(agentToolsMode({ document: {}, navigator: {} }), "shim");
  assert.equal(agentToolsMode({ document: { modelContext: { registerTool() {} } } }), "webmcp");
  assert.equal(getModelContext({ document: {}, navigator: {} }), null);
});
