import { test } from "node:test";
import assert from "node:assert/strict";
import { applyNativeOps, scanProjectInfo } from "../src/native/scan-bridge.ts";
import { emptyProject } from "../src/workstation/model.ts";
import { applyOps, type Op } from "../src/workstation/ops.ts";

function editor(readOnlyReason: string | null = null) {
  const ed = {
    project: emptyProject("t"), readOnlyReason,
    userEdit(ops: Op[]) { if (this.readOnlyReason) return null; this.project = applyOps(this.project, ops); return { revision: this.project.revision }; },
  };
  return ed;
}

test("native scan ops add a track with notes", () => {
  const ed = editor();
  const ops = [
    { op: "addTrack", id: "trk_s1", name: "Staff 1", channel: 0, program: 0, bankMsb: 0, bankLsb: 0, role: "melody" },
    { op: "addNotes", notes: [{ trackId: "trk_s1", channel: 0, tick: 0, duration: 480, pitch: 60, velocity: 80 }] },
  ];
  const r = applyNativeOps(ed, ops);
  assert.equal(r.ok, true);
  assert.ok(ed.project.tracks.some((t) => t.id === "trk_s1" && t.name === "Staff 1"));
  assert.equal(ed.project.notes.filter((n) => n.trackId === "trk_s1").length, 1);
  assert.deepEqual(scanProjectInfo(ed).noteCount, ed.project.notes.length);
});

test("native scan rejects other ops and read-only projects", () => {
  assert.equal(applyNativeOps(editor(), [{ op: "removeNotes", ids: [] }]).ok, false);
  const ro = applyNativeOps(editor("shared song"), [{ op: "setMeta", key: "C" }]);
  assert.equal(ro.ok, false);
  assert.match(ro.error ?? "", /READ_ONLY/);
  assert.equal(scanProjectInfo(editor("x")).readOnly, true);
});
