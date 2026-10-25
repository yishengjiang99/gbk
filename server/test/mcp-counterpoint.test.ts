// generate_part kind counterpoint needs againstTrack: the edit tool description says so, a missing field gets a
// clear INVALID_ARGUMENT naming it, and with it the edit succeeds.
import test from "node:test";
import assert from "node:assert/strict";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer } from "./ws-helpers.ts";
import { McpClient } from "./mcp-helpers.ts";

test("counterpoint edit: description documents againstTrack; missing -> clear error; present -> works", async () => {
  const s = await startServer(new ScriptModel([() => reply("unused")]));
  try {
    const c = new McpClient(s.base); await c.initialize();
    const list = (await c.send("tools/list", {})).rpc?.result as { tools: { name: string; description: string }[] };
    assert.match(list.tools.find((t) => t.name === "gbk_edit_composition")!.description, /againstTrack\? \(required for counterpoint/);
    const g = await c.call<{ compositionId: string; accessToken: string; revision: number; tracks: { id: string }[] }>("gbk_create_composition", { title: "CP", style: "classical", bars: 4, instrumentation: ["harpsichord", "harpsichord"], seed: 3 });
    const t = { compositionId: g.compositionId, accessToken: g.accessToken };
    const op = { type: "generate_part", track: g.tracks[1]!.id, startBar: 1, endBar: 4, kind: "counterpoint", seed: 1 };
    await assert.rejects(c.call("gbk_edit_composition", { ...t, expectedRevision: g.revision, operations: [op] }), (e: { payload?: { error?: { code: string; message: string } } }) =>
      e.payload?.error?.code === "INVALID_ARGUMENT" && /needs againstTrack \(/.test(e.payload.error.message));
    const ok = await c.call<{ revision: number }>("gbk_edit_composition", { ...t, expectedRevision: g.revision, operations: [{ ...op, againstTrack: g.tracks[0]!.id }] });
    assert.ok(ok.revision > g.revision);
  } finally { await s.app.close(); }
});
