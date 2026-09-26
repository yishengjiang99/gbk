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

  const pitches = new Set(song.tracks.flatMap((track) => track.notes.map((note) => note.note)));
  assert.ok(pitches.has(54), "F#3 from the D-major bass pattern should encode as MIDI 54");
  assert.ok(pitches.has(66), "F#4 from the right-hand pattern should encode as MIDI 66");
  assert.ok(song.tracks[1].notes.some((note) => note.channel === 1), "left-hand bass uses channel 1");
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

test("isSupportedSheetMusicImageFile accepts camera JPEGs labeled image/jpg or octet-stream", () => {
  assert.equal(
    isSupportedSheetMusicImageFile(new File([new Uint8Array([0xff, 0xd8, 0xff])], "photo.jpg", { type: "image/jpg" })),
    true
  );
  assert.equal(
    isSupportedSheetMusicImageFile(
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "scan.png", { type: "application/octet-stream" })
    ),
    true
  );
});

test("isSupportedSheetMusicImageFile still rejects SVG even with a png-like name", () => {
  assert.equal(
    isSupportedSheetMusicImageFile(new File([new Uint8Array([0x3c, 0x73, 0x76, 0x67])], "score.png", { type: "image/svg+xml" })),
    false
  );
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

test("buildDetectedSheetMusicMidi keeps treble and bass on separate channels", () => {
  const midiData = buildDetectedSheetMusicMidi([
    { midi: 71, startTick: 0, durationTicks: 480, velocity: 62, channel: 0 },
    { midi: 43, startTick: 0, durationTicks: 480, velocity: 50, channel: 1 },
  ]);
  const song = parseMidiBuffer(midiData);
  const notes = song.tracks[1].notes;
  assert.equal(notes.length, 2);
  assert.equal(notes.find((note) => note.note === 71)?.channel, 0);
  assert.equal(notes.find((note) => note.note === 43)?.channel, 1);
});

test("buildDetectedSheetMusicMidi skips non-finite note payloads", () => {
  const midiData = buildDetectedSheetMusicMidi([
    { midi: Number.NaN, startTick: 0, durationTicks: 480, velocity: 80 },
    { midi: 60, startTick: 0, durationTicks: 480, velocity: 80 },
  ]);
  const song = parseMidiBuffer(midiData);
  assert.deepEqual(
    song.tracks[1].notes.map((note) => note.note),
    [60]
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
