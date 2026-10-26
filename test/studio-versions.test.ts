import test from "node:test";
import assert from "node:assert/strict";
import { WorkstationController } from "../src/workstation/controller.ts";
import { VersionLog, friendlyError, plainStep } from "../src/components/studio/studio-logic.ts";

const addPiano = (c: WorkstationController, pitch: number) => c.edit([
  ...(c.project.tracks.length ? [] : [{ op: "addTrack" as const, id: "t1", name: "Piano", channel: 0 }]),
  { op: "addNotes", notes: [{ trackId: "t1", channel: 0, tick: c.project.notes.length * 96, duration: 96, pitch, velocity: 90 }] },
]);

test("each composer reply that changes the song is a new version; unchanged replies add none", () => {
  const c = new WorkstationController(); const log = new VersionLog();
  assert.equal(log.record("r0", c.project), null, "an empty song is not a version");
  addPiano(c, 60); assert.equal(log.record("r1", c.project)?.n, 1);
  assert.equal(log.record("r2", c.project), null, "reply that did not change the song");
  addPiano(c, 62); assert.equal(log.record("r3", c.project)?.n, 2);
  assert.equal(log.record("r3", c.project)?.n, 2, "same run is recorded once");
  assert.deepEqual(log.list(c.project.id).map((v) => v.n), [1, 2]);
  assert.equal(log.forRun(c.project.id, "r1")?.snapshot.notes.length, 1, "v1 keeps its own notes after later edits");
});

test("restoring an older version is one undoable edit that keeps the song's id and name", () => {
  const c = new WorkstationController(); const log = new VersionLog();
  addPiano(c, 60); const v1 = log.record("r1", c.project)!;
  addPiano(c, 62); addPiano(c, 64); c.rename("My tune");
  const before = c.project;
  assert.ok(c.restoreSnapshot(v1.snapshot, "restore v1"));
  assert.equal(c.project.notes.length, 1); assert.equal(c.project.id, before.id); assert.equal(c.project.name, "My tune");
  assert.ok(c.project.revision > before.revision);
  assert.ok(c.undo()); assert.equal(c.project.notes.length, 3, "undo brings the newer song back");
});

test("rename is undoable and ignores blank names", () => {
  const c = new WorkstationController(); const old = c.project.name;
  assert.equal(c.rename("   "), false); assert.ok(c.rename("Night Drive")); assert.equal(c.project.name, "Night Drive");
  c.undo(); assert.equal(c.project.name, old);
});

test("errors and steps are shown in plain words, never codes or tool names", () => {
  for (const raw of ["PROVIDER_RATE_LIMITED: 429 from upstream req_abc123", "TOKEN_BUDGET_EXHAUSTED: day cap 200000", "BROWSER_DISCONNECTED: not executed", "INTERNAL: stack at x.ts:12", "weird"]) {
    const m = friendlyError(raw);
    assert.doesNotMatch(m, /[A-Z]{3,}_|\d{3}|req_|\.ts/, `${raw} -> ${m}`);
  }
  assert.equal(plainStep("gbk_render_wav"), "Render wav");
  assert.equal(plainStep("writing the melody"), "Writing the melody");
});
