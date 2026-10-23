import test from "node:test";
import assert from "node:assert/strict";
import { emptyProject } from "../src/workstation/model.ts";
import { applyOps } from "../src/workstation/ops.ts";
import { diffNotes } from "../src/workstation/diff.ts";

test("proposal diff: added, removed, moved", () => {
  const p = emptyProject("d", 96);
  p.tracks.push({ id: "t", name: "t", channel: 0, color: "", visible: true, mix: { volume: 100, pan: 64, expression: 127, mute: false, solo: false } });
  p.notes.push({ id: "a", trackId: "t", channel: 0, tick: 0, duration: 96, pitch: 60, velocity: 80 }, { id: "b", trackId: "t", channel: 0, tick: 96, duration: 96, pitch: 62, velocity: 80 });
  const c = applyOps(p, [{ op: "removeNotes", ids: ["a"] }, { op: "updateNotes", updates: [{ id: "b", pitch: 64 }] }, { op: "addNotes", notes: [{ trackId: "t", channel: 0, tick: 0, duration: 48, pitch: 67, velocity: 70 }] }]);
  const d = diffNotes(p, c);
  assert.equal(d.added.length, 1); assert.equal(d.removed[0].id, "a"); assert.equal(d.moved[0].after.pitch, 64);
  assert.equal(p.notes.length, 2); // original untouched
});
