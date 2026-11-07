import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore, accountIdFor, isGuestAccount } from "../src/persistence/accounts.ts";
import { GUEST_PREFIX, isGuest } from "../src/mcp/guest.ts";
import { ACCESS_TTL_MS } from "../src/routes/native.ts";
import { McpStore } from "../src/mcp/store.ts";

const DAY = 86_400_000;
function at<T>(ms: number, f: () => T): T { const real = Date.now; Date.now = () => ms; try { return f(); } finally { Date.now = real; } }

test("account ids, guest upgrade, and MCP guest owners are orthogonal layers", () => {
  const accounts = new AccountStore(":memory:");
  assert.equal(accountIdFor("github", "abc"), "gh-abc");
  assert.equal(accountIdFor("google", "111"), "g-111");
  assert.equal(accountIdFor("apple", "xyz"), "ap-xyz");
  assert.equal(accountIdFor("phone", "1555"), "ph-1555");
  assert.equal(accountIdFor("guest", "dev1"), "gu-dev1");

  const { account } = accounts.upsertOAuth("guest", "dev1", "Guest", null);
  assert.equal(account.id, "gu-dev1");
  assert.equal(account.provider, "guest");
  assert.equal(isGuestAccount("gu-dev1"), true);
  assert.equal(isGuest("gu-dev1"), false, "an account guest is not an MCP guest: owner");

  accounts.link("gu-dev1", "google", "111", "Ana", "a@x.test");
  assert.equal(accounts.get("gu-dev1")!.id, "gu-dev1", "link keeps the original id");
  assert.equal(accounts.get("gu-dev1")!.provider, "google");
  assert.equal(isGuestAccount("gu-dev1"), false, "gu- prefix alone is not enough after upgrade");

  assert.equal(isGuest(GUEST_PREFIX + "abc"), true);
  assert.equal(isGuestAccount(GUEST_PREFIX + "abc"), false);
  assert.equal(ACCESS_TTL_MS, 3_600_000);
  assert.ok(ACCESS_TTL_MS < 14 * DAY, "native/MCP access TTL is not the 14-day unpublished guest prune");
  accounts.close();
});

test("MCP unpublished guest projects prune at 14 unused days; public and signed-in rows stay", () => {
  const dir = mkdtempSync(join(tmpdir(), "gbk-id-exp-")); const s = new McpStore(":memory:", dir);
  const old = Date.now() - 20 * DAY;
  const mk = (owner: string, when: number) => at(when, () => s.createComposition({ owner, title: "t", projectJson: JSON.stringify({ x: "y".repeat(1000) }), revision: 1 }));
  const art = (c: { id: string; owner: string }, when: number, size: number) => { const rel = `${c.id}-${when}.wav`; writeFileSync(join(s.artifactsDir, rel), Buffer.alloc(size)); return at(when, () => s.addArtifact({ job_id: null, composition_id: c.id, owner: c.owner, revision: 1, kind: "wav", filename: "a.wav", mime_type: "audio/wav", size_bytes: size, sha256: "0", rel_path: rel, meta_json: "{}" })); };
  const gOld = mk("guest:old", old), gNew = mk("guest:new", Date.now()), gPub = mk("guest:pub", old), acct = mk("g-user1", old);
  at(old, () => s.setVisibility(gPub.id, gPub.owner, "public"));
  const staleArt = art(gOld, old, 4_000_000); art(acct, old, 1_000_000);
  const pa = s.pruneGuestArtifacts(7); assert.equal(pa.count, 1); assert.equal(existsSync(join(s.artifactsDir, staleArt.rel_path)), false);
  const pc = s.pruneGuestCompositions(14); assert.equal(pc.count, 1);
  assert.equal(s.getCompositionAny(gOld.id), null);
  for (const c of [gNew, gPub, acct]) assert.ok(s.getCompositionAny(c.id), c.owner);
  assert.equal(s.listArtifacts(acct.id, acct.owner).length, 1);
  s.close();
});
