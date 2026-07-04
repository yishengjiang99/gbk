import test from "node:test";
import assert from "node:assert/strict";

import { buildSwedenSheetMusicMidi, parseSheetMusicToMidi } from "../src/sheet-music-reader.ts";
import { parseMidiBuffer } from "../src/midi-timer.worker.ts";

test("buildSwedenSheetMusicMidi returns MIDI that the app parser can load", () => {
  const midiData = buildSwedenSheetMusicMidi();
  const header = new TextDecoder("ascii").decode(new Uint8Array(midiData, 0, 4));

  assert.equal(header, "MThd");

  const song = parseMidiBuffer(midiData);
  assert.equal(song.format, 1);
  assert.equal(song.division, 480);
  assert.equal(song.bpm, 46);
  assert.equal(song.timeSig, "4/4");
  assert.equal(song.tracks.length, 2);
  assert.ok(song.tracks.some((track) => track.notes.length > 0));
});

test("parseSheetMusicToMidi accepts image files and returns demo MIDI with warning", async () => {
  const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], "sheet.jpg", { type: "image/jpeg" });
  const parsed = await parseSheetMusicToMidi(file);

  assert.equal(parsed.fileName, "scanned-sheet-demo-sweden.mid");
  assert.match(parsed.warnings.join(" "), /not implemented yet/i);
  assert.doesNotThrow(() => parseMidiBuffer(parsed.midiData));
});

test("parseSheetMusicToMidi rejects non-image files", async () => {
  const file = new File([new Uint8Array([0x4d, 0x54, 0x68, 0x64])], "song.mid", { type: "audio/midi" });

  await assert.rejects(() => parseSheetMusicToMidi(file), /image file/);
});
