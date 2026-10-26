// Automation Read per lane: the controller's playback toggle and the SMF the player receives.
import test from "node:test";
import assert from "node:assert/strict";
import { WorkstationController } from "../src/workstation/controller.ts";
import { parseSmf, serializeSmf } from "../src/workstation/smf.ts";

function seeded() {
  const c = new WorkstationController();
  c.edit([{ op: "addTrack", name: "A", channel: 0, id: "t_a", program: 0 },
    { op: "addNotes", notes: [{ trackId: "t_a", channel: 0, tick: 0, duration: 480, pitch: 60, velocity: 90 }] },
    { op: "setCC", trackId: "t_a", channel: 0, controller: 11, startTick: 0, endTick: 960, mode: "replace", points: [{ tick: 0, value: 40 }, { tick: 960, value: 120 }] },
    { op: "setCC", trackId: "t_a", channel: 0, controller: 10, startTick: 0, endTick: 0, mode: "replace", points: [{ tick: 0, value: 20 }] }], { label: "seed" });
  return c;
}

test("automation Read is per (track, lane), defaults on, not part of the song", () => {
  const c = seeded(); const rev = c.project.revision;
  assert.equal(c.automationRead("t_a", 11), true);
  c.setAutomationRead("t_a", 11, false);
  assert.equal(c.automationRead("t_a", 11), false); assert.equal(c.automationRead("t_a", 10), true);
  assert.equal(c.project.revision, rev, "toggling Read is not an edit");
  c.setAutomationRead("t_a", 11, false); assert.deepEqual(c.getState().automationOff, ["t_a:11"]);
  c.setAutomationRead("t_a", 11, true); assert.deepEqual(c.getState().automationOff, []);
});

test("serializeSmf skipCC leaves exactly that lane out of the playback stream; export keeps it", () => {
  const c = seeded(); const p = c.project;
  const ccs = (bytes: Uint8Array) => parseSmf(bytes.buffer.slice(0) as ArrayBuffer, "x").ccs.map((e) => `${e.controller}@${e.tick}=${e.value}`).sort();
  assert.deepEqual(ccs(serializeSmf(p)), ["10@0=20", "11@0=40", "11@960=120"]);
  assert.deepEqual(ccs(serializeSmf(p, { skipCC: (t, cc) => t === "t_a" && cc === 11 })), ["10@0=20"]);
});
