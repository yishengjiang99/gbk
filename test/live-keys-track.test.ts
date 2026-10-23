// Keys panel follows the workstation selection and the selected track's program/bank (renderer-resolved preset).
import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./support/compose-setup.ts";
import { Sf2LiveSink, type LiveGraph } from "../src/workstation/live-sink.ts";
import { LiveInputSession } from "../src/workstation/live-input.ts";
import { peekSoundFont, loadSoundFont } from "../src/audio/soundfont-loader.ts";
import { resolveTrackPreset } from "../src/audio/offline-renderer.ts";

function fakeGraph() {
  const msgs: Record<string, unknown>[] = []; const mix: [number, number][] = [];
  const g: LiveGraph = { post: (m) => msgs.push(m), setMix: (a, b) => mix.push([a, b]), latencyMs: 5, state: "running", resume() {} };
  return { g, msgs, mix, presets: () => msgs.filter((m) => m.type === "setPreset") };
}
async function rig() {
  const s = setup(); await loadSoundFont();
  await s.call("gbk_create_project", { name: "Keys", tempo: 120, replaceCurrent: true });
  const ids: string[] = (await s.call("gbk_create_track", { tracks: [{ name: "Piano", program: 0 }, { name: "Flute", program: 73, pan: 20, volume: 50 }] })).data.trackIds;
  const f = fakeGraph();
  const sink = new Sf2LiveSink(s.c, async () => f.g); await sink.prepare();
  const session = new LiveInputSession(s.c, sink, { tickNow: () => 0 });
  return { ...s, ids, f, sink, session };
}
const presetOf = (c: ReturnType<typeof setup>["c"], id: string) => resolveTrackPreset(c.project, id, peekSoundFont()!.sf)!;

test("keyboard plays the selected track; switching the selection re-points the engine immediately (before the next note)", async () => {
  const { c, ids, f, sink, session } = await rig();
  c.setSelection({ trackIds: [ids[0]] });
  session.noteOn(60, 100); session.noteOff(60);
  assert.equal(sink.current?.presetName, presetOf(c, ids[0]).presetName);
  assert.equal(f.presets().slice(-1)[0]!.regions, presetOf(c, ids[0]).regions);
  const before = f.presets().length;
  c.setSelection({ trackIds: [ids[1]] });                         // track list / piano roll / dropdown all set this
  assert.equal(f.presets().length, before + 1, "setPreset sent on selection change, no note needed");
  assert.equal(sink.current?.trackId, ids[1]); assert.equal(sink.current?.program, 73); assert.match(sink.current!.presetName, /Flute/);
  assert.equal(f.presets().slice(-1)[0]!.regions, presetOf(c, ids[1]).regions);
  assert.deepEqual(f.mix.slice(-1)[0], [0.25, (20 - 64) / 63]);         // the Flute's fader + pan
  const n = f.msgs.length; session.noteOn(72, 90);
  assert.deepEqual(f.msgs.slice(n), [{ type: "noteOn", channel: 0, note: 72, velocity: 90 }], "hot path: no extra preset reload");
  session.noteOff(72);
  assert.deepEqual(sink.describe(ids[1]), sink.current);
});

test("a program/bank change on the selected track reloads the right preset live", async () => {
  const { c, call, ids, f, sink, session } = await rig();
  c.setSelection({ trackIds: [ids[1]] });
  assert.equal(sink.current?.program, 73);
  const r = await call("gbk_set_instrument", { trackId: ids[1], program: 40 });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(sink.current?.program, 40); assert.match(sink.current!.presetName, /Violin/);
  assert.equal(f.presets().slice(-1)[0]!.regions, presetOf(c, ids[1]).regions);
  c.edit([{ op: "setProgram", trackId: ids[1], program: 0, bankMsb: 8, bankLsb: 0 }], { label: "bank" });
  const want = presetOf(c, ids[1]);
  assert.equal(sink.current?.presetIndex, want.presetIndex); assert.equal(f.presets().slice(-1)[0]!.regions, want.regions);
  // a program change on a track that is NOT selected does not steal the keyboard
  const k = f.presets().length;
  c.edit([{ op: "setProgram", trackId: ids[0], program: 19, bankMsb: 0, bankLsb: 0 }], { label: "organ" });
  assert.equal(f.presets().length, k); assert.equal(sink.current?.trackId, ids[1]);
  session.noteOn(60); assert.equal((f.msgs.slice(-1)[0] as { type: string }).type, "noteOn");
});

test("no selection: the keyboard uses the first track", async () => {
  const { c, ids, sink } = await rig();
  c.setSelection({ trackIds: [] }); sink.refresh();
  assert.equal(sink.current?.trackId, ids[0]);
});
