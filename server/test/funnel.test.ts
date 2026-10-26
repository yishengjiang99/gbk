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
