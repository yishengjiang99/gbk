// Listing metadata (plugins/gbk-composer/plugin.json) stays within OpenAI directory limits and only
// claims what the composer supports; tool descriptions/annotations advertised over tools/list match.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STRATEGIES } from "../../src/music/arrangement.ts";
import { INSTRUMENTS } from "../../src/music/compose.ts";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer } from "./ws-helpers.ts";
import { McpClient } from "./mcp-helpers.ts";

const plugin = JSON.parse(readFileSync(new URL("../../plugins/gbk-composer/plugin.json", import.meta.url), "utf8"));
const ui = plugin.extensions["com.openai"].interface;

test("plugin.json listing fields fit final-submission limits", () => {
  assert.equal(ui.displayName, "GBK Composer");
  assert.ok(ui.displayName.length <= 30);
  assert.ok(ui.shortDescription.length <= 30 && !ui.shortDescription.includes("\n"));
  assert.ok(ui.longDescription.length <= 4000);
  assert.ok(plugin.description.length <= 1024);
  assert.ok(ui.defaultPrompt.length >= 1 && ui.defaultPrompt.length <= 3);
  assert.equal(new Set(ui.defaultPrompt).size, ui.defaultPrompt.length);
  for (const p of ui.defaultPrompt) assert.ok(p.length <= 128 && !p.includes("\n"), p);
});

test("listing claims match supported styles and instruments; no server-render claim", () => {
  for (const style of ["baroque", "classical", "pop", "jazz", "ambient"]) assert.ok(STRATEGIES[style], style);
  assert.equal(Object.keys(STRATEGIES).length, 5);
  const named = ui.longDescription.match(/including (.+?) and drums\./)![1].split(/, /).concat("drums");
  for (const n of named) assert.ok(INSTRUMENTS[n.trim()], `instrument ${n}`);
  const all = [plugin.description, ui.longDescription, ...ui.defaultPrompt].join(" ");
  assert.doesNotMatch(all, /server-side render|no (open )?browser tab is required|stretto/i);
  assert.match(ui.longDescription, /rendered in your own browser, never on GBK.s server/);
});

test("tools/list advertises 'Use this' descriptions and publish is the only open-world tool", async () => {
  const s = await startServer(new ScriptModel([() => reply("x")]), { MCP_TEST_AUTH: "1" });
  try {
    const c = new McpClient(s.base); await c.initialize();
    const tools = ((await c.send("tools/list", {})).rpc?.result as { tools: { name: string; description: string; annotations: Record<string, boolean> }[] }).tools;
    for (const t of tools) {
      if (t.name.startsWith("gbk_widget_render_")) continue; // app-only (ui.visibility ["app"]): called by the in-chat player, never the model
      if (t.name !== "gbk_cancel_render" && t.name !== "gbk_publish_composition") assert.match(t.description, /^Use this/, t.name);
      assert.equal(t.annotations.openWorldHint, t.name === "gbk_publish_composition", t.name);
      assert.equal(t.annotations.destructiveHint, t.name === "gbk_delete_composition", t.name);
    }
    assert.match(tools.find((t) => t.name === "gbk_render_composition")!.description, /never synthesizes audio/);
  } finally { await s.app.close(); }
});

test("tool input schemas avoid array-form 'items' (strict tool-calling APIs reject draft-07 tuples)", async () => {
  const s = await startServer(new ScriptModel([() => reply("x")]));
  try {
    const c = new McpClient(s.base); await c.initialize();
    const tools = ((await c.send("tools/list", {})).rpc?.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
    const bad: string[] = [];
    const walk = (n: unknown, path: string) => { if (!n || typeof n !== "object") return; const o = n as Record<string, unknown>; if (Array.isArray(o.items)) bad.push(path); for (const [k, v] of Object.entries(o)) walk(v, `${path}/${k}`); };
    for (const t of tools) walk(t.inputSchema, t.name);
    assert.deepEqual(bad, []);
  } finally { await s.app.close(); }
});
