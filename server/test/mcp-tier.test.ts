// Tier limits (#132): revision snapshots kept per composition (Free 10 / Pro 100), render-file
// retention (Free 30 days / Pro 365), max composition length (Free 64 / Pro 256 bars) — enforced
// through the unified ProStatus (CompositionService.proOf, wired by app.ts to AccountLimits.pro).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testConfig } from "./helpers.ts";
import { McpStore } from "../src/mcp/store.ts";
import { CompositionService } from "../src/mcp/service.ts";
import { ShareStore } from "../src/persistence/shares.ts";

const DAY = 86_400_000;

test("store: pruneRevisions keeps only the newest N snapshots", () => {
  const dir = mkdtempSync(join(tmpdir(), "gbk-tier-"));
  const s = new McpStore(":memory:", dir);
  const c = s.createComposition({ owner: "g-u1", title: "t", projectJson: "{}", revision: 1 });
  let rev = 1;
  for (let i = 0; i < 5; i++) {
    const saved = s.saveRevision({ id: c.id, owner: "g-u1", title: "t", projectJson: "{}", expectedRevision: rev, newRevision: rev + 1, summary: "edit" });
    assert.ok(saved); rev++;
  }
  assert.equal(s.listRevisions(c.id, "g-u1").length, 6);
  assert.equal(s.pruneRevisions(c.id, 3), 3);
  assert.deepEqual(s.listRevisions(c.id, "g-u1").map((r) => r.revision), [4, 5, 6]);
  assert.equal(s.getRevision(c.id, "g-u1", 6)?.revision, 6, "the current revision snapshot is always kept");
  assert.equal(s.pruneRevisions(c.id, 3), 0, "idempotent");
  s.close();
});

test("store: pruneArtifacts keeps Pro owners' files for the Pro window", () => {
  const dir = mkdtempSync(join(tmpdir(), "gbk-tier-"));
  const s = new McpStore(":memory:", dir);
  const old = Date.now() - 40 * DAY;
  const mk = (owner: string) => {
    const c = s.createComposition({ owner, title: "t", projectJson: "{}", revision: 1 });
    const rel = `${c.id}.wav`; writeFileSync(join(s.artifactsDir, rel), Buffer.alloc(4));
    const real = Date.now; Date.now = () => old;
    try { return s.addArtifact({ job_id: null, composition_id: c.id, owner, revision: 1, kind: "wav", filename: "a.wav", mime_type: "audio/wav", size_bytes: 4, sha256: "0", rel_path: rel, meta_json: "{}" }); }
    finally { Date.now = real; }
  };
  const free = mk("g-free"), pro = mk("g-pro");
  const removed = s.pruneArtifacts(30, 365, (o) => o === "g-pro");
  assert.equal(removed, 1, "only the free owner's 40-day-old artifact is pruned");
  assert.equal(existsSync(join(s.artifactsDir, free.rel_path)), false);
  assert.equal(existsSync(join(s.artifactsDir, pro.rel_path)), true);
  assert.equal(s.pruneArtifacts(30), 1, "without the tier rule the Pro file goes at 30 days");
  s.close();
});

test("service: bars cap and revision pruning follow the owner's tier", async () => {
  const cfg = testConfig({ TIER_FREE_REVISIONS: "3" });
  const dir = mkdtempSync(join(tmpdir(), "gbk-tier-"));
  const store = new McpStore(":memory:", dir);
  const svc = new CompositionService(cfg, store, new ShareStore(":memory:"));
  const sig = new AbortController().signal;
  const base = { title: "Tier Test", style: "classical", key: "C major", tempo: 100, seed: 1 } as const;

  // Free account: 80 bars exceeds the 64-bar Free cap before any generation runs.
  await assert.rejects(svc.create("g-free", { ...base, bars: 80 }, sig), /limited to 64 bars/);
  // Pro (unified ProStatus predicate): 80 bars is fine, 300 exceeds even the Pro cap.
  svc.proOf = () => true;
  await assert.rejects(svc.create("g-pro", { ...base, bars: 300 }, sig), /limited to 256 bars/);
  const { row } = await svc.create("g-pro", { ...base, bars: 80 }, sig);
  assert.ok(row.id);

  // Free account edits prune revision history to the newest TIER_FREE_REVISIONS snapshots.
  svc.proOf = () => false;
  const made = await svc.create("g-free", { ...base, bars: 4 }, sig);
  let rev = made.row.revision;
  for (const bpm of [101, 102, 103, 104, 105]) {
    const r = await svc.edit("g-free", made.row.id, rev, [{ type: "set_tempo", bpm }], sig);
    rev = r.row.revision;
  }
  const kept = store.listRevisions(made.row.id, "g-free");
  assert.equal(kept.length, 3, "free history pruned to the newest 3");
  assert.equal(kept[kept.length - 1].revision, rev, "the current revision is among the kept");
  store.close();
});
