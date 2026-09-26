import test from "node:test";
import assert from "node:assert/strict";

import {
  createMidiMessageHandler,
  isMidiPermissionDeniedError,
  type MidiData,
} from "../src/midi-driver.ts";

test("createMidiMessageHandler decodes note on/off messages", async () => {
  const events: unknown[] = [];
  const handler = createMidiMessageHandler({
    onNoteOn: (note, velocity, channel) => events.push({ type: "noteOn", note, velocity, channel }),
    onNoteOff: (note, channel) => events.push({ type: "noteOff", note, channel }),
  });

  assert.equal(handler.handleMidiMessage([0x92, 64, 120]), true);
  assert.equal(handler.handleMidiMessage(new Uint8Array([0x82, 64, 0])), true);
  assert.equal(handler.handleMidiMessage([0x92, 64, 0]), true);

  assert.deepEqual(events, [
    { type: "noteOn", note: 64, velocity: 120, channel: 2 },
    { type: "noteOff", note: 64, channel: 2 },
    { type: "noteOff", note: 64, channel: 2 },
  ]);
});

test("createMidiMessageHandler tracks bank select before program change", async () => {
  const events: unknown[] = [];
  const handler = createMidiMessageHandler({
    onProgramChange: (program, bank, channel) =>
      events.push({ type: "programChange", program, bank, channel }),
  });

  handler.handleMidiMessage([0xb5, 0, 2]);
  handler.handleMidiMessage([0xb5, 32, 17]);
  handler.handleMidiMessage([0xc5, 40]);

  assert.deepEqual(events, [
    { type: "programChange", program: 40, bank: (2 << 7) | 17, channel: 5 },
  ]);
});

test("createMidiMessageHandler ignores unsupported payloads", async () => {
  const handler = createMidiMessageHandler({});

  assert.equal(handler.handleMidiMessage(null), false);
  assert.equal(handler.handleMidiMessage("bad" as unknown as MidiData), false);
  assert.equal(handler.handleMidiMessage([0xe0, 0, 64]), false);
});

test("isMidiPermissionDeniedError recognizes browser MIDI permission denial", () => {
  assert.equal(
    isMidiPermissionDeniedError(new DOMException("Permission to use Web MIDI API was not granted.", "NotAllowedError")),
    true
  );
  assert.equal(isMidiPermissionDeniedError(new Error("Web MIDI is not supported in this browser.")), false);
});
