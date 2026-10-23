import test from "node:test";
import assert from "node:assert/strict";
import { parseMidiBuffer } from "../src/midi-timer.worker.ts";
import { emptyProject } from "../src/workstation/model.ts";
import { serializeSmf } from "../src/workstation/smf.ts";
import { controllerStateAt, ctlToSynth } from "../src/workstation/controller-events.ts";
import { buildMidiSendEvents } from "../src/midi-output.ts";

function fixture() {
  const p = emptyProject("cc", 480);
  p.tracks.push({ id: "a", name: "A", channel: 3, color: "", visible: true, mix: { volume: 100, pan: 64, expression: 127, mute: false, solo: false } });
  p.notes.push({ id: "n", trackId: "a", channel: 3, tick: 0, duration: 1920, pitch: 60, velocity: 100 });
  for (const [tick, cc, v] of [[0, 11, 20], [480, 11, 80], [960, 1, 64], [960, 64, 127], [1440, 74, 30], [1500, 91, 90], [1600, 64, 0]]) p.ccs.push({ id: `c${tick}${cc}`, trackId: "a", channel: 3, controller: cc, tick, value: v });
  p.pitchBends.push({ id: "b", trackId: "a", channel: 3, tick: 240, value: 16383 });
  p.channelPressure.push({ id: "p", trackId: "a", channel: 3, tick: 300, value: 99 });
  return p;
}

test("worker parser keeps timed CC (not only CC0/32), bend, pressure with channel identity", () => {
  const song = parseMidiBuffer(serializeSmf(fixture()).buffer as ArrayBuffer);
  const evs = song.tracks[1].playEvents;
  const ccs = evs.filter((e) => e.type === "cc").map((e) => [(e as { controller: number }).controller, (e as { value: number }).value, e.channel]);
  assert.deepEqual(ccs, [[11, 20, 3], [11, 80, 3], [1, 64, 3], [64, 127, 3], [74, 30, 3], [91, 90, 3], [64, 0, 3]]);
  assert.equal(evs.find((e) => e.type === "pitchBend")!.channel, 3);
  assert.equal((evs.find((e) => e.type === "pitchBend") as { value: number }).value, 16383);
  assert.ok(evs.find((e) => e.type === "channelPressure"));
  const cc11b = evs.find((e) => e.type === "cc" && (e as { value: number }).value === 80)!;
  assert.equal(cc11b.sec, 0.5); // tick 480 @120bpm
});

test("controller messages map to engine dispatch shape", () => {
  assert.deepEqual(ctlToSynth({ sec: 0, seq: 0, type: "cc", channel: 3, controller: 11, value: 5 }), { type: "controlChange", channel: 3, controller: 11, value: 5 });
  assert.deepEqual(ctlToSynth({ sec: 0, seq: 0, type: "pitchBend", channel: 3, value: 16383 }), { type: "pitchBend", channel: 3, velocity: 16383 });
});

test("seek reconstruction: reset, mix base, last authored values; sustain released when seeking past pedal-up", () => {
  const song = parseMidiBuffer(serializeSmf(fixture()).buffer as ArrayBuffer);
  const evs = song.tracks[1].playEvents;
  const at = (sec: number) => controllerStateAt(evs, sec, { cc7: 90, cc10: 30, cc11: 127 });
  const s1 = at(1.01);
  assert.deepEqual(s1.slice(0, 4).map((e) => [e.controller, e.value]), [[121, 0], [7, 90], [10, 30], [11, 127]]);
  const last = (list: typeof s1, cc: number) => list.filter((e) => e.type === "cc" && e.controller === cc).pop()?.value;
  assert.equal(last(s1, 11), 80);
  assert.equal(last(s1, 64), 127); // pedal down at 1.0s
  assert.equal(last(at(1.7), 64), 0);
  assert.equal(at(1.01).find((e) => e.type === "pitchBend")!.value, 16383);
  assert.equal(last(at(0.1), 11), 20);
});

test("MIDI out carries timed CC + controller state at start", () => {
  const song = parseMidiBuffer(serializeSmf(fixture()).buffer as ArrayBuffer);
  const all = buildMidiSendEvents(song as never, 0);
  assert.ok(all.some((e) => e.bytes[0] === 0xb3 && e.bytes[1] === 11 && e.bytes[2] === 80));
  assert.ok(all.some((e) => e.bytes[0] === 0xe3));
  const mid = buildMidiSendEvents(song as never, 0.75);
  assert.ok(mid.some((e) => e.sec === 0.75 && e.bytes[0] === 0xb3 && e.bytes[1] === 11 && e.bytes[2] === 80));
});
