// Unified ingress (src/synth-ingress.ts): the wire shapes every realtime source now shares, the
// SynthIngress sink semantics, and the ONE bank-select folding the raw-MIDI handler and the SMF
// parser both use. The expected messages below are the exact objects the three sources used to
// build inline (worker port posts, App live handlers, Sf2LiveSink) before the unification.
import test from "node:test";
import assert from "node:assert/strict";
import { BankSelectTracker, createSynthIngress, synthEvent, type SynthIngress } from "../src/synth-ingress.ts";
import type { SynthEvent } from "../src/sf2-renderer.ts";
import { createMidiMessageHandler } from "../src/midi-driver.ts";
import { parseMidiBuffer } from "../src/midi-timer.worker.ts";
import { emptyProject } from "../src/workstation/model.ts";
import { serializeSmf } from "../src/workstation/smf.ts";

test("synthEvent builders produce the legacy wire shapes", () => {
  assert.deepEqual(synthEvent.noteOn(3, 60, 100), { type: "noteOn", channel: 3, note: 60, velocity: 100 });
  assert.deepEqual(synthEvent.noteOff(3, 60), { type: "noteOff", channel: 3, note: 60 });
  assert.deepEqual(synthEvent.controlChange(0, 64, 127), { type: "controlChange", channel: 0, controller: 64, value: 127 });
  assert.deepEqual(synthEvent.pitchBend(0, 16383), { type: "pitchBend", channel: 0, velocity: 16383 });
  assert.deepEqual(synthEvent.channelPressure(2, 88), { type: "channelPressure", channel: 2, value: 88 });
  assert.deepEqual(synthEvent.polyPressure(2, 61, 40), { type: "polyPressure", channel: 2, note: 61, value: 40 });
  const regions = [] as never[];
  assert.deepEqual(synthEvent.setPreset(regions), { type: "setPreset", regions });
  assert.deepEqual(synthEvent.setPreset(regions, 0), { type: "setPreset", channel: 0, regions });
});

function recorder() {
  const msgs: SynthEvent[] = [];
  return { msgs, send: (m: SynthEvent) => { msgs.push(m); } };
}

test("createSynthIngress: every verb reaches the sink with the same values", () => {
  const { msgs, send } = recorder();
  const sink: SynthIngress = createSynthIngress(send);
  sink.noteOn(1, 62, 90);
  sink.noteOff(1, 62);
  sink.controlChange(1, 11, 70);
  sink.pitchBend(1, 8192);
  sink.channelPressure(1, 33);
  sink.polyPressure(1, 62, 44);
  sink.programChange(1, 40, 300); // default: engine programChange (bank comes from forwarded CC0 state)
  sink.allNotesOff(1);
  sink.allSoundOff(1);
  assert.deepEqual(msgs, [
    { type: "noteOn", channel: 1, note: 62, velocity: 90 },
    { type: "noteOff", channel: 1, note: 62 },
    { type: "controlChange", channel: 1, controller: 11, value: 70 },
    { type: "pitchBend", channel: 1, velocity: 8192 },
    { type: "channelPressure", channel: 1, value: 33 },
    { type: "polyPressure", channel: 1, note: 62, value: 44 },
    { type: "programChange", channel: 1, program: 40 },
    { type: "controlChange", channel: 1, controller: 123, value: 0 },
    { type: "controlChange", channel: 1, controller: 120, value: 0 },
  ]);
});

test("createSynthIngress: onProgramChange intercepts for external preset resolution", () => {
  const { msgs, send } = recorder();
  const resolved: [number, number, number][] = [];
  const sink = createSynthIngress(send, { onProgramChange: (ch, prog, bank) => resolved.push([ch, prog, bank]) });
  sink.programChange(5, 40, (2 << 7) | 17);
  assert.deepEqual(resolved, [[5, 40, (2 << 7) | 17]]);
  assert.deepEqual(msgs, []); // nothing reaches the engine until the resolver answers with setPreset
  sink.setPreset([], 5);
  assert.deepEqual(msgs, [{ type: "setPreset", channel: 5, regions: [] }]);
});

test("BankSelectTracker: folds CC0/CC32 per channel, ignores other CCs, resets", () => {
  const t = new BankSelectTracker();
  assert.equal(t.bank(5), 0);
  t.observe(0, 2, 5);
  assert.equal(t.bank(5), 2 << 7);
  t.observe(32, 17, 5);
  assert.equal(t.bank(5), (2 << 7) | 17);
  t.observe(7, 100, 5); // not a bank CC
  assert.equal(t.bank(5), (2 << 7) | 17);
  assert.equal(t.bank(4), 0); // channels are independent
  t.observe(32, 3, 4);
  assert.equal(t.bank(4), 3);
  t.observe(0, 200, 4); // values are 7-bit masked
  assert.equal(t.bank(4), ((200 & 0x7f) << 7) | 3);
  t.reset();
  assert.equal(t.bank(5), 0);
  assert.equal(t.bank(4), 0);
});

test("bank folding agrees across adapters: raw-MIDI handler and SMF parser", () => {
  // Player live adapter (midi-driver handler): CC0/CC32 fold into the program callback's bank.
  const programs: [number, number, number][] = [];
  const handler = createMidiMessageHandler({
    onProgramChange: (program, bank, channel) => programs.push([program, bank, channel]),
  });
  handler.handleMidiMessage([0xb3, 0, 1]);   // ch3 CC0 = 1
  handler.handleMidiMessage([0xb3, 32, 9]);  // ch3 CC32 = 9
  handler.handleMidiMessage([0xc3, 12]);     // ch3 program 12
  assert.deepEqual(programs, [[12, (1 << 7) | 9, 3]]);

  // Scheduler adapter (SMF parser): the same fold lands on the timed program playEvent, and the
  // bank CCs themselves are consumed (not routed as timed CCs).
  const p = emptyProject("banks", 480);
  p.tracks.push({ id: "a", name: "A", channel: 3, color: "", visible: true, mix: { volume: 100, pan: 64, expression: 127, mute: false, solo: false } });
  p.ccs.push({ id: "c0", trackId: "a", channel: 3, controller: 0, tick: 0, value: 1 });
  p.ccs.push({ id: "c32", trackId: "a", channel: 3, controller: 32, tick: 0, value: 9 });
  p.programs.push({ id: "pg", trackId: "a", channel: 3, tick: 0, program: 12, bankMsb: 1, bankLsb: 9 });
  const song = parseMidiBuffer(serializeSmf(p).buffer as ArrayBuffer);
  const evs = song.tracks.flatMap((t) => t.playEvents);
  const prog = evs.find((e) => e.type === "program") as { program: number; bank: number } | undefined;
  assert.ok(prog, "program playEvent exists");
  assert.equal(prog.program, 12);
  assert.equal(prog.bank, (1 << 7) | 9);
  assert.deepEqual(evs.filter((e) => e.type === "cc"), []); // bank CCs consumed by the fold
});
