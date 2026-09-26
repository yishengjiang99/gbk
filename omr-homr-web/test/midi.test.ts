/*
 * MIDI contract tests: the SMF produced from decoded symbols must be exactly
 * what gbk's midi-timer.worker.ts parses — this is the playback proof for the
 * Phase 2 demo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  groupIntoChords,
  parseKernDuration,
  pitchToMidi,
  symbolsToMidi,
  TICKS_PER_QUARTER,
} from "../src/midi.js";
import { parseMidiBuffer } from "../../src/midi-timer.worker.js";
import type { DecodedSymbol } from "../src/vocab.js";

const root = dirname(fileURLToPath(import.meta.url));
const oracle: DecodedSymbol[] = JSON.parse(
  readFileSync(join(root, "fixtures", "c-scale-raw-tokens.json"), "utf8"),
);

function sym(rhythm: string, pitch = ".", lift = "_"): DecodedSymbol {
  return { rhythm, pitch, lift, articulation: "_", slur: "_", position: "upper", attention: [0, 0] };
}

describe("token -> MIDI primitives", () => {
  it("maps scientific pitch notation, C4 = 60", () => {
    assert.equal(pitchToMidi("C4", "_"), 60);
    assert.equal(pitchToMidi("A4", "_"), 69);
    assert.equal(pitchToMidi("C5", "_"), 72);
    assert.equal(pitchToMidi("G9", "_"), 127);
    assert.equal(pitchToMidi("B9", "_"), null); // 131: outside MIDI range
  });

  it("applies lifts as semitone offsets", () => {
    assert.equal(pitchToMidi("C4", "#"), 61);
    assert.equal(pitchToMidi("C4", "##"), 62);
    assert.equal(pitchToMidi("E4", "b"), 63);
    assert.equal(pitchToMidi("E4", "bb"), 62);
    assert.equal(pitchToMidi("F4", "N"), 65);
  });

  it("rejects non-note pitches", () => {
    assert.equal(pitchToMidi(".", "_"), null);
    assert.equal(pitchToMidi("_", "_"), null);
    assert.equal(pitchToMidi("H4", "_"), null);
  });

  it("parses kern durations at 480 TPQ", () => {
    assert.deepEqual(parseKernDuration("note_4"), { ticks: 480, grace: false, isRest: false });
    assert.deepEqual(parseKernDuration("note_2"), { ticks: 960, grace: false, isRest: false });
    assert.deepEqual(parseKernDuration("note_8."), { ticks: 360, grace: false, isRest: false });
    assert.deepEqual(parseKernDuration("note_16.."), { ticks: 210, grace: false, isRest: false });
    assert.deepEqual(parseKernDuration("rest_4"), { ticks: 480, grace: false, isRest: true });
    const grace = parseKernDuration("note_8G");
    assert.equal(grace?.grace, true);
    assert.equal(parseKernDuration("note_4")?.ticks, TICKS_PER_QUARTER);
    assert.equal(parseKernDuration("barline"), null);
    assert.equal(parseKernDuration("clef_G2"), null);
    assert.equal(parseKernDuration("timeSignature/4"), null);
  });

  it("groups chord tokens onto the previous onset", () => {
    const groups = groupIntoChords([sym("note_4", "C4"), sym("chord"), sym("note_4", "E4"), sym("note_4", "G4")]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].length, 2);
    assert.equal(groups[1].length, 1);
  });
});

describe("oracle C-scale -> SMF", () => {
  it("emits 15 quarter notes at the expected pitches and ticks", () => {
    const { midi, noteEvents, staffCount, warnings } = symbolsToMidi([oracle]);
    assert.equal(staffCount, 1);
    assert.deepEqual(warnings, []);
    assert.equal(noteEvents.length, 15);
    const expected = [64, 65, 67, 69, 71, 72, 74, 76, 74, 72, 71, 69, 67, 65, 64];
    noteEvents.forEach((ev, i) => {
      assert.equal(ev.midi, expected[i], `note ${i} pitch`);
      assert.equal(ev.tick, i * 480, `note ${i} tick`);
      assert.equal(ev.durationTicks, 480, `note ${i} duration`);
    });
    assert.ok(midi.length > 100);
  });

  it("the existing timer worker parses and can play it", () => {
    const { midi } = symbolsToMidi([oracle], "homr scan");
    const song = parseMidiBuffer(midi.buffer as ArrayBuffer);
    assert.equal(song.format, 1);
    assert.equal(song.division, 480);
    assert.equal(song.tracks.length, 2); // conductor + one staff
    assert.equal(song.timeSig, "4/4");
    assert.ok(Math.abs(song.bpm - 72) < 0.01, `bpm ${song.bpm}`);
    const staff = song.tracks[1];
    assert.equal(staff.notes.length, 15);
    // Quarter notes at 72 BPM = 0.8333s each, back to back.
    staff.notes.forEach((n, i) => {
      assert.ok(Math.abs(n.startSec - (i * 60) / 72) < 1e-4, `note ${i} startSec ${n.startSec}`);
      assert.ok(Math.abs(n.durationSec - 60 / 72) < 1e-4, `note ${i} durationSec ${n.durationSec}`);
      assert.equal(n.channel, 0);
      assert.ok(n.velocity > 0);
    });
    const pitches = staff.notes.map((n) => n.note);
    assert.deepEqual(pitches, [64, 65, 67, 69, 71, 72, 74, 76, 74, 72, 71, 69, 67, 65, 64]);
    assert.ok(song.durationSec > 12 && song.durationSec < 14, `duration ${song.durationSec}`);
  });

  it("rests advance the cursor and chords share onsets", () => {
    const symbols = [
      sym("note_4", "C4"),
      sym("rest_4"),
      sym("note_4", "E4"),
      sym("chord"),
      sym("note_4", "G4"),
    ];
    const { noteEvents } = symbolsToMidi([symbols]);
    assert.deepEqual(noteEvents.map((e) => [e.midi, e.tick]), [
      [60, 0],
      [64, 960],
      [67, 960],
    ]);
  });
});
