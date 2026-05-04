import test from "node:test";
import assert from "node:assert/strict";

import { generateBachMidi } from "../src/bach-generator.ts";
import { parseMidiBuffer } from "../src/midi-timer.worker.ts";

test("generateBachMidi creates a parseable multi-track MIDI file", () => {
  const generated = generateBachMidi({ seed: 12345 });
  const song = parseMidiBuffer(generated.midiData);

  assert.equal(generated.fileName, "generated-bach-12345.mid");
  assert.equal(song.tracks.length, 4);
  assert.equal(song.bpm, 92);
  assert.equal(song.timeSig, "4/4");
  assert.ok(song.durationSec > 0);
  assert.ok(song.tracks.reduce((sum, track) => sum + track.notes.length, 0) > 0);
});
