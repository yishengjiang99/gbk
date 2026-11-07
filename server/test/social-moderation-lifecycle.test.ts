import test from "node:test";
import assert from "node:assert/strict";
import { ShareStore } from "../src/persistence/shares.ts";
import { SocialStore } from "../src/persistence/social.ts";

function social() {
  const shares = new ShareStore(":memory:");
  return { shares, social: new SocialStore(shares.database) };
}

test("three distinct open comment reports auto-hide the comment but leave the reports open for admin", () => {
  const { shares, social: s } = social();
  const song = shares.create({ owner: "alice", title: "Song", projectJson: "{}", public: true });
  const c = s.addComment(song.id, "bob", "hello");
  const target = String(c.id);
  s.report({ reporter: "r1", kind: "comment", target, reason: "spam" });
  s.report({ reporter: "r2", kind: "comment", target, reason: "spam" });
  s.report({ reporter: "r1", kind: "comment", target, reason: "spam" });
  assert.equal(s.comment(c.id)!.hidden, 0, "the same reporter twice does not count as three");
  s.report({ reporter: "r3", kind: "comment", target, reason: "spam" });
  assert.equal(s.comment(c.id)!.hidden, 1);
  assert.equal(s.comments(song.id, { order: "new", limit: 10 }).rows.length, 0, "hidden comments drop out of the public list");
  const open = s.reports({ status: "open", limit: 20 }).rows.filter((r) => r.target_id === target);
  assert.ok(open.length >= 3);
  assert.ok(open.every((r) => r.status === "open"), "auto-hide does not resolve reports");
  s.report({ reporter: "r4", kind: "comment", target, reason: "spam" });
  assert.ok(s.reports({ status: "open", limit: 20 }).rows.filter((r) => r.target_id === target).length >= 4);

  const songReport = s.report({ reporter: "r1", kind: "song", target: song.slug, reason: "copied" });
  assert.equal(s.reports({ status: "open", limit: 30 }).rows.find((r) => r.id === songReport)?.status, "open");
  assert.ok(shares.byId(song.id), "song reports never hide or delete the song");
});

test("removeComment is first-write-wins: hidden and deleted_at are exclusive", () => {
  const { shares, social: s } = social();
  const song = shares.create({ owner: "alice", title: "Song", projectJson: "{}", public: true });
  const hidden = s.addComment(song.id, "bob", "hide me");
  s.removeComment(hidden.id, "hidden");
  assert.equal(s.comment(hidden.id)!.hidden, 1);
  s.removeComment(hidden.id, "deleted_at");
  assert.equal(s.comment(hidden.id)!.deleted_at, null);
  assert.equal(s.comment(hidden.id)!.hidden, 1);

  const deleted = s.addComment(song.id, "bob", "delete me");
  s.removeComment(deleted.id, "deleted_at");
  assert.ok(s.comment(deleted.id)!.deleted_at);
  s.removeComment(deleted.id, "hidden");
  assert.equal(s.comment(deleted.id)!.hidden, 0);
});
