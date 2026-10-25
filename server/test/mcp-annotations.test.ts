// Every tool's MCP annotations match its behavior (OpenAI portal validation, 2026-10-24: cancel and claim were
// wrongly non-destructive). If you add or change a tool, update this table deliberately.
import test from "node:test";
import assert from "node:assert/strict";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer } from "./ws-helpers.ts";
import { McpClient } from "./mcp-helpers.ts";

type A = { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
const R = (idem = true): A => ({ readOnlyHint: true, destructiveHint: false, idempotentHint: idem, openWorldHint: false });
const W = (idempotentHint: boolean, destructiveHint: boolean, openWorldHint = false): A => ({ readOnlyHint: false, destructiveHint, idempotentHint, openWorldHint });
export const EXPECTED: Record<string, A> = {
  gbk_get_capabilities: R(), gbk_list_soundfonts: R(), gbk_get_composition: R(), gbk_list_compositions: R(),
  gbk_get_render_status: R(), gbk_get_artifacts: R(), gbk_open_workstation: R(), gbk_show_composition_ui: R(),
  gbk_create_composition: W(false, false),          // new private composition; nothing existing changes
  gbk_render_composition: W(false, false),          // adds artifacts for a revision; nothing is removed
  gbk_widget_render_start: W(false, false), gbk_widget_render_finish: W(true, false),
  gbk_edit_composition: W(false, false),            // writes a new revision; earlier revisions are kept and renderable
  gbk_cancel_render: W(true, true),                 // discards the in-progress render; no partial artifact kept
  gbk_publish_composition: W(true, true, true),     // makes it public on the web; no unpublish tool
  gbk_claim_composition: W(true, true),             // moves the project to the account; old access keys stop working
  gbk_delete_composition: W(true, true),            // permanent deletion
};

test("tools/list annotations match the expected table for all tools", async () => {
  const s = await startServer(new ScriptModel([() => reply("unused")]));
  try {
    const c = new McpClient(s.base); await c.initialize();
    const tools = ((await c.send("tools/list", {})).rpc?.result as { tools: { name: string; annotations: A }[] }).tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(EXPECTED).sort(), "every listed tool has an expected row (and vice versa)");
    for (const t of tools) {
      const { readOnlyHint, destructiveHint, idempotentHint, openWorldHint } = t.annotations;
      assert.deepEqual({ readOnlyHint, destructiveHint, idempotentHint, openWorldHint }, EXPECTED[t.name], t.name);
      if (readOnlyHint) assert.equal(destructiveHint, false, `${t.name}: read-only tools can't be destructive`);
    }
  } finally { await s.app.close(); }
});
