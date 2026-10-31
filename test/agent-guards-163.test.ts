import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./support/compose-setup.ts";

// #163 #8: mutation guards - agent undo is scoped to agent edits; pitch transforms refuse on percussion.

test("gbk_undo refuses to revert the user's edit (NOT_AGENT_EDIT), but undoes the agent's own", async () => {
  const { c, call } = setup();
  await call("gbk_create_project", { name: "guarded", tempo: 100 });
  await call("gbk_create_track", { tracks: [{ name: "Violin", program: 40 }] });
  // A direct user edit lands on top of the agent's work (UI path: source "user" by default).
  c.edit([{ op: "setTempoMap", events: [{ tick: 0, microPerQuarter: 400_000 }] }], { label: "user tempo" });
  const refused = await call("gbk_undo");
  assert.equal(refused.ok, false);
  assert.equal(refused.error!.code, "NOT_AGENT_EDIT");
  assert.equal(c.project.tempos[0].microPerQuarter, 400_000, "the user's edit is untouched");
  // The user undoes their own edit; now the agent's edit is on top and agent undo works.
  assert.equal(c.undo(), true);
  const ok = await call("gbk_undo");
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  assert.equal(ok.data.undone, true);
  const redo = await call("gbk_redo");
  assert.equal(redo.ok, true); assert.equal(redo.data.redone, true);
});

test("gbk_transform_notes: pitch transforms refuse on percussion unless includePercussion, timing transforms stay allowed", async () => {
  const { c, call } = setup();
  await call("gbk_create_project", { name: "drums", tempo: 100 });
  const tr = await call("gbk_create_track", { tracks: [{ name: "Drums", role: "percussion" }] });
  const drumId = tr.data.trackIds[0];
  const part = await call("gbk_generate_part", { trackId: drumId, range: { unit: "bars", start: 1, end: 4 }, kind: "drums", seed: 7 });
  assert.ok(part.ok, JSON.stringify(part.error));
  assert.ok(c.project.notes.length > 0);
  const range = { unit: "bars", start: 1, end: 4 };
  const refused = await call("gbk_transform_notes", { trackId: drumId, range, transform: "transpose", semitones: 12 });
  assert.equal(refused.ok, false);
  assert.equal(refused.error!.code, "PERCUSSION_PITCH_GUARD");
  const allowed = await call("gbk_transform_notes", { trackId: drumId, range, transform: "transpose", semitones: 12, includePercussion: true });
  assert.equal(allowed.ok, true, JSON.stringify(allowed.error));
  const timing = await call("gbk_transform_notes", { trackId: drumId, range, transform: "quantize", grid: 0.25, strength: 1 });
  assert.equal(timing.ok, true, JSON.stringify(timing.error));
});
