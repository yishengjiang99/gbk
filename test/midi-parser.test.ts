import test from "node:test";
import assert from "node:assert/strict";

import { parseMidiBuffer, type Song, type SongTrack } from "../src/midi-timer.worker.ts";

// ---------------------------------------------------------------------------
// Helpers to build minimal MIDI binary data
// ---------------------------------------------------------------------------

/** Encode a number as a MIDI variable-length value. */
function varLen(value: number): number[] {
  if (value < 0x80) return [value];
  if (value < 0x4000) return [0x80 | (value >> 7), value & 0x7f];
  return [0x80 | (value >> 14), 0x80 | ((value >> 7) & 0x7f), value & 0x7f];
}

/** Build a 4-byte big-endian uint32. */
function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** Build a MIDI format-0 file with a single track of raw event bytes. */
function buildMidi0(division: number, eventBytes: number[]): ArrayBuffer {
  const eof: number[] = [0x00, 0xff, 0x2f, 0x00]; // delta=0 + end-of-track
  const trackData = [...eventBytes, ...eof];
  const bytes = [
    // MThd
    0x4d, 0x54, 0x68, 0x64,
    ...u32be(6),       // chunk length
    0x00, 0x00,        // format 0
    0x00, 0x01,        // 1 track
    ...[(division >> 8) & 0xff, division & 0xff],
    // MTrk
    0x4d, 0x54, 0x72, 0x6b,
    ...u32be(trackData.length),
    ...trackData,
  ];
  return new Uint8Array(bytes).buffer;
}

/** Build a format-1 file with multiple tracks of raw event-byte arrays. */
function buildMidi1(division: number, tracks: number[][]): ArrayBuffer {
  const chunks: number[] = [
    0x4d, 0x54, 0x68, 0x64,
    ...u32be(6),
    0x00, 0x01,                // format 1
    ...[(tracks.length >> 8) & 0xff, tracks.length & 0xff],
    ...[(division >> 8) & 0xff, division & 0xff],
  ];
  for (const t of tracks) {
    const eof = [0x00, 0xff, 0x2f, 0x00];
    const data = [...t, ...eof];
    chunks.push(0x4d, 0x54, 0x72, 0x6b, ...u32be(data.length), ...data);
  }
  return new Uint8Array(chunks).buffer;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("parseMidiBuffer rejects non-MIDI header", () => {
  const bad = new Uint8Array(14).fill(0);
  assert.throws(() => parseMidiBuffer(bad.buffer), /Invalid MIDI header/);
});

test("parseMidiBuffer rejects SMPTE time division", () => {
  // division with high bit set = SMPTE
  const buf = buildMidi0(0x8000 | 25, []);
  assert.throws(() => parseMidiBuffer(buf), /SMPTE/);
});

test("parseMidiBuffer parses empty format-0 file", () => {
  const buf = buildMidi0(480, []);
  const song: Song = parseMidiBuffer(buf);
  assert.equal(song.format, 0);
  assert.equal(song.division, 480);
  assert.equal(song.bpm, 120);
  assert.equal(song.timeSig, "4/4");
  assert.equal(song.tracks.length, 1);
  assert.equal(song.tracks[0].playEvents.length, 0);
});

test("parseMidiBuffer parses a note-on / note-off pair into a note record", () => {
  const division = 480;
  // delta=0: note-on ch0, note=60, vel=100
  // delta=480 (= 1 quarter note): note-off ch0, note=60
  const events: number[] = [
    0x00, 0x90, 60, 100,           // delta=0, note-on ch0 note=60 vel=100
    ...varLen(480), 0x80, 60, 0,   // delta=480, note-off ch0 note=60
  ];
  const buf = buildMidi0(division, events);
  const song = parseMidiBuffer(buf);
  const track: SongTrack = song.tracks[0];

  assert.equal(track.notes.length, 1);
  const note = track.notes[0];
  assert.equal(note.note, 60);
  assert.equal(note.velocity, 100);
  assert.equal(note.channel, 0);
  // At 120 BPM, 480 ticks = 0.5 s
  assert.ok(Math.abs(note.durationSec - 0.5) < 0.001, `duration ${note.durationSec} should be ~0.5s`);
});

test("parseMidiBuffer emits noteOn and noteOff playEvents", () => {
  const division = 480;
  const events: number[] = [
    0x00, 0x91, 64, 80,           // delta=0, note-on ch1 note=64 vel=80
    ...varLen(960), 0x81, 64, 0,  // delta=960, note-off ch1 note=64
  ];
  const buf = buildMidi0(division, events);
  const song = parseMidiBuffer(buf);
  const playEvs = song.tracks[0].playEvents;

  assert.equal(playEvs.length, 2);
  assert.equal(playEvs[0].type, "noteOn");
  assert.equal(playEvs[1].type, "noteOff");

  const on = playEvs[0];
  assert.ok(on.type === "noteOn");
  assert.equal(on.note, 64);
  assert.equal(on.velocity, 80);
  assert.equal(on.channel, 1);
  assert.ok(Math.abs(on.sec - 0) < 0.001);

  const off = playEvs[1];
  assert.ok(off.type === "noteOff");
  assert.equal(off.note, 64);
  // 960 ticks at 120 BPM, division=480 → 1 s
  assert.ok(Math.abs(off.sec - 1.0) < 0.001, `sec ${off.sec} should be ~1.0`);
});

test("parseMidiBuffer respects a tempo meta event", () => {
  // Tempo meta: FF 51 03 <3-byte microseconds>
  // 60 BPM = 1000000 µs/quarter
  const microPerQ = 1000000;
  const division = 480;
  const tempoEvent: number[] = [
    0x00, 0xff, 0x51, 0x03,
    (microPerQ >> 16) & 0xff,
    (microPerQ >> 8) & 0xff,
    microPerQ & 0xff,
  ];
  const noteEvent: number[] = [
    0x00, 0x90, 60, 100,
    ...varLen(480), 0x80, 60, 0,
  ];
  const buf = buildMidi0(division, [...tempoEvent, ...noteEvent]);
  const song = parseMidiBuffer(buf);

  assert.equal(song.bpm, 60);
  const note = song.tracks[0].notes[0];
  // At 60 BPM, 480 ticks = 1.0 s
  assert.ok(Math.abs(note.durationSec - 1.0) < 0.001, `duration ${note.durationSec} should be ~1.0s`);
});

test("parseMidiBuffer records a program change event", () => {
  const division = 480;
  // CC 0 (bank MSB) + CC 32 (bank LSB) then program change
  const events: number[] = [
    0x00, 0xb0, 0, 0,    // bank MSB = 0
    0x00, 0xb0, 32, 0,   // bank LSB = 0
    0x00, 0xc0, 40,      // program change: program=40
  ];
  const buf = buildMidi0(division, events);
  const song = parseMidiBuffer(buf);
  const playEvs = song.tracks[0].playEvents;

  assert.equal(playEvs.length, 1);
  assert.equal(playEvs[0].type, "program");
  const prog = playEvs[0];
  assert.ok(prog.type === "program");
  assert.equal(prog.program, 40);
  assert.equal(prog.bank, 0);
});

test("parseMidiBuffer bank is computed from CC 0 / CC 32", () => {
  const division = 480;
  const events: number[] = [
    0x00, 0xb3, 0, 2,    // ch3 bank MSB = 2
    0x00, 0xb3, 32, 17,  // ch3 bank LSB = 17
    0x00, 0xc3, 40,      // ch3 program = 40
  ];
  const buf = buildMidi0(division, events);
  const song = parseMidiBuffer(buf);
  const prog = song.tracks[0].playEvents[0];
  assert.ok(prog.type === "program");
  assert.equal(prog.bank, (2 << 7) | 17);
});

test("parseMidiBuffer reports correct timeSig from meta event", () => {
  const division = 480;
  // Time signature 3/4: FF 58 04 03 02 xx xx  (numerator=3, denominator exponent=2 → 4)
  const timeSigEvent: number[] = [
    0x00, 0xff, 0x58, 0x04, 3, 2, 24, 8,
  ];
  const buf = buildMidi0(division, timeSigEvent);
  const song = parseMidiBuffer(buf);
  assert.equal(song.timeSig, "3/4");
});

test("parseMidiBuffer handles format-1 multi-track file", () => {
  const division = 480;
  const tempoTrack: number[] = [
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // 500000 µs → 120 BPM
  ];
  const noteTrack: number[] = [
    0x00, 0x90, 60, 100,
    ...varLen(480), 0x80, 60, 0,
  ];
  const buf = buildMidi1(division, [tempoTrack, noteTrack]);
  const song = parseMidiBuffer(buf);

  assert.equal(song.format, 1);
  assert.equal(song.tracks.length, 2);
  const noteTrackResult = song.tracks[1];
  assert.equal(noteTrackResult.notes.length, 1);
  assert.equal(noteTrackResult.notes[0].note, 60);
});

test("parseMidiBuffer sets track name from meta 0x03", () => {
  const division = 480;
  // Track name meta: FF 03 <len> <chars>
  const name = "Piano";
  const nameBytes = [...name].map((c) => c.charCodeAt(0));
  const events: number[] = [
    0x00, 0xff, 0x03, nameBytes.length, ...nameBytes,
  ];
  const buf = buildMidi0(division, events);
  const song = parseMidiBuffer(buf);
  assert.equal(song.tracks[0].name, "Piano");
});
