import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShareStore, kebabTitle, nameSlug, shortIdOf } from "../src/persistence/shares.ts";
import { parseRoute } from "../../src/agent/routes.ts";

test("create/rename/publish move the slug; old slugs keep resolving", () => {
  const st = new ShareStore(":memory:");
  const r = st.create({ owner: "a", title: "Midnight Invention", projectJson: "{}" });
  assert.match(r.slug, /^midnight-invention-[a-z0-9]{8}$/);
  const old = r.slug, sid = shortIdOf(old)!;
  st.setTitle(old, "Dawn Fugue"); st.setPublic(old, false);
  const now = st.bySlug(old)!;
  assert.equal(now.slug, `dawn-fugue-${sid}`); assert.equal(now.public, 0);
  assert.equal(st.bySlug(sid)!.id, r.id); assert.equal(st.bySlug(`whatever-${sid}`)!.id, r.id);
  assert.equal(st.bySlug("zzzzzzzz"), null);
  const a = st.upsertAutosave({ owner: "a", projectId: "p1", title: "Untitled", projectJson: "{}" }).row;
  assert.match(a.slug, /^untitled-/);
  const a2 = st.upsertAutosave({ owner: "a", projectId: "p1", title: "Better Name", projectJson: "{}" }).row;
  assert.equal(a2.id, a.id); assert.match(a2.slug, /^better-name-/);
  st.delete(a.slug); assert.equal(st.bySlug(a2.slug), null);
});

test("migration backfills legacy bare slugs to name slugs", () => {
  const f = join(mkdtempSync(join(tmpdir(), "slug-")), "s.db");
  const db = new DatabaseSync(f);
  db.exec(`CREATE TABLE shares (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, title TEXT NOT NULL, project_json TEXT NOT NULL, parent_id TEXT, created_at INTEGER NOT NULL, public INTEGER NOT NULL DEFAULT 1, midi BLOB, wav BLOB, wav_meta TEXT)`);
  db.prepare("INSERT INTO shares (id, slug, owner, title, project_json, created_at) VALUES (?,?,?,?,?,?)").run("shr_1", "crqebmyf", "a", "The Clockwork Cathedral", "{}", 1);
  db.close();
  const st = new ShareStore(f);
  assert.equal(st.bySlug("crqebmyf")!.slug, "the-clockwork-cathedral-crqebmyf");
  assert.equal(st.list({ limit: 10, offset: 0 })[0].slug, "the-clockwork-cathedral-crqebmyf");
  new ShareStore(f); // idempotent
});
