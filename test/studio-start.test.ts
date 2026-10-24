import { test } from "node:test";
import assert from "node:assert/strict";
import { isOwnProject } from "../src/workstation/persistence.ts";
import { emptyProject } from "../src/workstation/model.ts";
import { WorkstationController } from "../src/workstation/controller.ts";

test("open shares and the legacy auto-loaded demo are never restored on /studio", () => {
  const demo = emptyProject("60884_Beethoven-Symphony-No51");
  assert.equal(isOwnProject(demo), false);
  assert.equal(isOwnProject({ ...demo, revision: 3 }), true, "a user who edited the demo keeps their work");
  const shared = { ...emptyProject("Song"), meta: { owner: "user" as const, sharedFrom: { slug: "abc", title: "Song", owner: "x", parentSlug: null } } };
  assert.equal(isOwnProject(shared as never), false);
  assert.equal(isOwnProject(emptyProject("My song")), true);
});

test("new project starts blank and writable, even from a read-only share", async () => {
  const c = new WorkstationController();
  c.loadShared({ ...emptyProject("Shared"), tracks: [{ id: "t1" } as never] });
  assert.ok(c.readOnlyReason);
  await c.createProject({ name: "Untitled", owner: "user", replaceCurrent: true });
  assert.equal(c.readOnlyReason, null);
  assert.equal(c.project.tracks.length, 0);
  assert.equal(c.project.notes.length, 0);
});
