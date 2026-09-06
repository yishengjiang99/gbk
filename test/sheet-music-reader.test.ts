import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDetectedSheetMusicMidi,
  buildSwedenSheetMusicMidi,
  isSupportedSheetMusicImageFile,
  parseSheetMusicToMidi,
} from "../src/sheet-music-reader.ts";
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

test("parseSheetMusicToMidi rejects unavailable recognition instead of returning unrelated music", async () => {
  const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], "sheet.jpg", { type: "image/jpeg" });
  assert.equal(isSupportedSheetMusicImageFile(file), true);
  await assert.rejects(() => parseSheetMusicToMidi(file), /recognition is unavailable/);
});

test("parseSheetMusicToMidi accepts JPG/PNG images when the browser omits the MIME type", async () => {
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "scan.PNG");
  assert.equal(isSupportedSheetMusicImageFile(file), true);
});

test("parseSheetMusicToMidi accepts JPG/PNG images when the file name has no extension", async () => {
  const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], "captured-image", { type: "image/jpeg" });
  assert.equal(isSupportedSheetMusicImageFile(file), true);
});

test("buildDetectedSheetMusicMidi encodes detected notes into a parseable MIDI file", () => {
  const midiData = buildDetectedSheetMusicMidi(
    [
      { midi: 60, startTick: 0, durationTicks: 480, velocity: 80 },
      { midi: 64, startTick: 480, durationTicks: 480, velocity: 82 },
      { midi: 67, startTick: 960, durationTicks: 960, velocity: 84 },
    ],
    "detected test"
  );
  const song = parseMidiBuffer(midiData);

  assert.equal(song.format, 1);
  assert.equal(song.division, 480);
  assert.equal(song.bpm, 46);
  assert.equal(song.timeSig, "4/4");
  assert.equal(song.tracks.length, 2);
  assert.equal(song.tracks[1].notes.length, 3);
  assert.deepEqual(
    song.tracks[1].notes.map((note) => note.note),
    [60, 64, 67]
  );
});

test("parseSheetMusicToMidi rejects non-image files", async () => {
  const file = new File([new Uint8Array([0x4d, 0x54, 0x68, 0x64])], "song.mid", { type: "audio/midi" });

  await assert.rejects(() => parseSheetMusicToMidi(file), /image file/);
});

test("parseSheetMusicToMidi rejects unsupported image formats", async () => {
  const file = new File([new Uint8Array([0x3c, 0x73, 0x76, 0x67])], "score.svg", { type: "image/svg+xml" });

  await assert.rejects(() => parseSheetMusicToMidi(file), /JPG or PNG/);
});
