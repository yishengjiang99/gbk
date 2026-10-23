import test from "node:test";
import assert from "node:assert/strict";
import { recorderEventsToSmf } from "../src/workstation/recording.ts";
import { parseSmf } from "../src/workstation/smf.ts";

test("recorder events -> SMF -> project keeps notes, CC, bend, pressure with timing", () => {
  const p = parseSmf(recorderEventsToSmf([
    { deltaMs: 0, bytes: [0x90, 60, 100] }, { deltaMs: 250, bytes: [0xb0, 64, 127] }, { deltaMs: 300, bytes: [0xe0, 0, 80] },
    { deltaMs: 400, bytes: [0xd0, 50] }, { deltaMs: 500, bytes: [0x80, 60, 0] }, { deltaMs: 600, bytes: [0xf8] },
  ]));
  assert.equal(p.notes.length, 1); assert.equal(p.notes[0].duration, 480);
  assert.equal(p.ccs[0].tick, 240); assert.equal(p.pitchBends[0].value, 80 << 7); assert.equal(p.channelPressure[0].value, 50);
});
