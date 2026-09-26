import test from "node:test";
import assert from "node:assert/strict";

import { buildMidiSendEvents } from "../src/midi-output.ts";

const song = {
  tracks: [
    {
      notes: [
        { note: 60, velocity: 96, channel: 2, startSec: 1, durationSec: 3 },
      ],
      playEvents: [
        { type: "program", sec: 0, channel: 2, program: 41, bank: 130 },
        { type: "noteOn", sec: 1, channel: 2, note: 60, velocity: 96 },
        { type: "noteOff", sec: 4, channel: 2, note: 60 },
      ],
    },
  ],
};

test("buildMidiSendEvents does not duplicate program setup at the beginning", () => {
  const events = buildMidiSendEvents(song, 0);

  assert.deepEqual(
    events.slice(0, 3).map((event) => event.bytes),
    [
      [0xb2, 0, 1],
      [0xb2, 32, 2],
      [0xc2, 41],
    ]
  );
  assert.equal(events.filter((event) => (event.bytes[0] & 0xf0) === 0xc0).length, 1);
});

test("buildMidiSendEvents restores notes sounding at a mid-song start", () => {
  const events = buildMidiSendEvents(song, 2);

  assert.deepEqual(
    events.map((event) => ({ sec: event.sec, bytes: event.bytes })),
    [
      { sec: 2, bytes: [0xb2, 0, 1] },
      { sec: 2, bytes: [0xb2, 32, 2] },
      { sec: 2, bytes: [0xc2, 41] },
      { sec: 2, bytes: [0x92, 60, 96] },
      { sec: 4, bytes: [0x82, 60, 64] },
    ]
  );
});
