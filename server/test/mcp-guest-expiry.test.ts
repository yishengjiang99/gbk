// Guest MCP storage: per-project cap (renders included), global cap on project data only, expiry of untouched
// unpublished guest projects and old guest renders. Accounts and public compositions are never pruned.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpStore } from "../src/mcp/store.ts";

const DAY = 86_400_000;
function at<T>(ms: number, f: () => T): T { const real = Date.now; Date.now = () => ms; try { return f(); } finally { Date.now = real; } }

test("guest MCP expiry + storage accounting", () => {
  const dir = mkdtempSync(join(tmpdir(), "gbk-mcp-exp-")); const s = new McpStore(":memory:", dir);
  const old = Date.now() - 20 * DAY;
  const mk = (owner: string, when: number) => at(when, () => s.createComposition({ owner, title: "t", projectJson: JSON.stringify({ x: "y".repeat(1000) }), revision: 1 }));
  const art = (c: { id: string; owner: string }, when: number, size: number) => { const rel = `${c.id}-${when}.wav`; writeFileSync(join(s.artifactsDir, rel), Buffer.alloc(size)); return at(when, () => s.addArtifact({ job_id: null, composition_id: c.id, owner: c.owner, revision: 1, kind: "wav", filename: "a.wav", mime_type: "audio/wav", size_bytes: size, sha256: "0", rel_path: rel, meta_json: "{}" })); };
  const gOld = mk("guest:old", old), gOldRendered = mk("guest:oldr", old), gNew = mk("guest:new", Date.now()), gPub = mk("guest:pub", old), acct = mk("g-user1", old);
  at(old, () => s.setVisibility(gPub.id, gPub.owner, "public"));
  const a1 = art(gOld, old, 5_000_000); art(gOldRendered, Date.now() - DAY, 3_000_000); art(acct, old, 1_000_000);
  // global guest bytes exclude artifacts; per-owner bytes include them
  const global = s.guestStorageBytes(); assert.ok(global < 100_000, String(global));
  assert.ok(s.guestStorageBytes("guest:old") > 5_000_000);
  // guest renders expire after 7 days, account ones are left to the normal retention
  const pa = s.pruneGuestArtifacts(7); assert.equal(pa.count, 1); assert.equal(pa.bytes, 5_000_000); assert.equal(existsSync(join(s.artifactsDir, a1.rel_path)), false);
  // 14-day project expiry: only the untouched, private guest project goes
  const pc = s.pruneGuestCompositions(14); assert.equal(pc.count, 1); assert.ok(pc.bytes > 0);
  assert.equal(s.getCompositionAny(gOld.id), null);
  for (const c of [gOldRendered, gNew, gPub, acct]) assert.ok(s.getCompositionAny(c.id), c.owner);
  assert.equal(s.listArtifacts(acct.id, acct.owner).length, 1);
  // idempotent
  assert.deepEqual(s.pruneGuestCompositions(14), { count: 0, bytes: 0 });
  s.close();
});
