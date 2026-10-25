import test from "node:test";
import assert from "node:assert/strict";
import { validateHumOps, installHumBridge } from "../src/hum/native-bridge.ts";
import { humToOps } from "../src/hum/notes-to-ops.ts";
import { WorkstationController } from "../src/workstation/controller.ts";
import { emptyProject } from "../src/workstation/model.ts";

(globalThis as { window?: unknown }).window ??= Object.assign(new EventTarget(), {});
test("hum bridge: apply humToOps output as a new 'Hummed melody' track (one undo step); validation errors; context", () => {
  const c = new WorkstationController(emptyProject("Mine", 480)); c.host.checkpoint = async () => {};
  c.userEdit([{ op: "addTrack", id: "t0", name: "Piano", channel: 0 }]);
  const api = installHumBridge(c);
  assert.deepEqual(api.context(), { ppq: 480, tempos: c.project.tempos.map((t) => ({ tick: t.tick, microPerQuarter: t.microPerQuarter })), tracks: [{ channel: 0 }], readOnlyReason: null });
  const ops = humToOps(c.project, [{ pitchMidi: 60, startSec: 0, endSec: 0.5, amplitude: 0.8 }, { pitchMidi: 64, startSec: 0.5, endSec: 1, amplitude: 0.5 }], "hum1");
  const json = JSON.parse(JSON.stringify(ops)); json[0].name = "Evil"; json[0].program = 99;
  const r = api.apply(json, { label: "hum a melody", selectTrackId: "hum1" });
  assert.equal(r.ok, true); const t = c.project.tracks.find((x) => x.id === "hum1")!;
  assert.equal(t.name, "Hummed melody"); assert.equal(t.channel, 1); assert.equal(c.project.notes.filter((n) => n.trackId === "hum1").length, 2);
  assert.deepEqual(c.project.selection.trackIds, ["hum1"]);
  assert.equal(api.apply(json).ok, false, "same id again rejected");
  assert.ok(c.undo()); assert.equal(c.project.tracks.length, 1);
  const bad = (f: (o: Record<string, unknown>[]) => void) => { const o = JSON.parse(JSON.stringify(ops)); f(o); return validateHumOps(o, ["t0"]); };
  for (const [f, re] of [[(o: Record<string, unknown>[]) => o.pop(), /addTrack, addNotes/], [(o: Record<string, unknown>[]) => { o[0].channel = 9; }, /channel/],
    [(o: Record<string, unknown>[]) => { (o[1].notes as Record<string, unknown>[])[0].pitch = 200; }, /bad note/], [(o: Record<string, unknown>[]) => { (o[1].notes as Record<string, unknown>[])[0].trackId = "t0"; }, /new track/],
    [(o: Record<string, unknown>[]) => { o[1].notes = []; }, /notes/]] as const) assert.match((bad(f) as { error: string }).error, re);
  assert.equal(api.apply("nope").ok, false);
});
