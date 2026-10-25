// Runs the MCP acceptance harness (scenarios A, B, C, E) against a local server with real headless rendering.
import test from "node:test";
import assert from "node:assert/strict";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer } from "./ws-helpers.ts";
import { runAcceptance } from "../../scripts/acceptance/mcp-acceptance.ts";

test("acceptance harness: first use, revision continuity, session recovery, failures", { timeout: 300_000 }, async () => {
  const s = await startServer(new ScriptModel([() => reply("unused")]));
  try {
    const checks = await runAcceptance(s.base);
    const failed = checks.filter((c) => !c.ok);
    assert.deepEqual(failed, [], JSON.stringify(failed, null, 1));
    assert.ok(checks.length >= 30, `${checks.length} checks`);
  } finally { await s.app.close(); }
});
