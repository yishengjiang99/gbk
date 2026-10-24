import assert from "node:assert/strict";
import test from "node:test";

import { createLiveTakeCapture } from "../src/live-take.ts";
import { parseMidiBuffer } from "../src/midi-timer.worker.ts";
import type { PlayEvent } from "../src/midi-timer.worker.ts";
import type { CtlPlayEvent } from "../src/workstation/controller-events.ts";

function fakeClock(start = 10_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

test("capture is inert until armed, and arm() clears the previous take", () => {
  const clock = fakeClock();
  const take = createLiveTakeCapture(clock.now);
  take.noteOn(60, 100); // not armed: dropped
  assert.equal(take.eventCount(), 0);

  take.arm();
  clock.advance(100);
  take.noteOn(60, 100);
  clock.advance(200);
  take.noteOff(60);
  assert.equal(take.noteCount(), 1);
  assert.equal(take.hasUnsavedNotes(), true);

  take.markSaved();
  assert.equal(take.hasUnsavedNotes(), false);

  take.arm(); // fresh take
  assert.equal(take.eventCount(), 0);
  assert.equal(take.noteCount(), 0);
  assert.equal(take.hasUnsavedNotes(), false);
});

test("events are timestamped relative to take start (arm), including the lead-in", () => {
  const clock = fakeClock();
  const take = createLiveTakeCapture(clock.now);
  take.arm();
  clock.advance(2000); // player waits 2 s before the first note
  take.noteOn(64, 90);
  clock.advance(500);
  take.noteOff(64);

  const notes = take.notes();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].note, 64);
  assert.equal(notes[0].velocity, 90);
  assert.ok(Math.abs(notes[0].startSec - 2) < 1e-9, `start ${notes[0].startSec}`);
  assert.ok(Math.abs(notes[0].durationSec - 0.5) < 1e-9, `duration ${notes[0].durationSec}`);
});

test("held notes extend to now in notes() and are closed at the end in toFile()", () => {
  const clock = fakeClock();
  const take = createLiveTakeCapture(clock.now);
  take.arm();
  take.noteOn(72, 80);
  clock.advance(750);

  const live = take.notes();
  assert.equal(live.length, 1);
  assert.ok(Math.abs(live[0].durationSec - 0.75) < 1e-9);

  const file = take.toFile(new Date(2026, 9, 24, 11, 5, 3));
  assert.ok(file);
  assert.equal(file.name, "gbk-take-20261024-110503.mid");
  const parsed = parseMidiBuffer(file.bytes.buffer as ArrayBuffer);
  const evs = parsed.tracks.flatMap((t) => t.playEvents);
  const on = evs.find(
    (e): e is Extract<PlayEvent, { type: "noteOn" }> => e.type === "noteOn" && e.note === 72
  );
  const off = evs.find(
    (e): e is Extract<PlayEvent, { type: "noteOff" }> => e.type === "noteOff" && e.note === 72
  );
  assert.ok(on && off, "the saved file pairs the held note with a note-off");
  assert.equal(on.velocity, 80);
  assert.ok(Math.abs(off.sec - 0.75) < 0.002, `off at ${off.sec}`);
});

test("round trip: captured performance survives SMF serialize + parse", () => {
  const clock = fakeClock();
  const take = createLiveTakeCapture(clock.now);
  take.arm();
  take.controlChange(0, 1); // bank MSB (hardware sends bank before program)
  take.controlChange(32, 9); // bank LSB
  take.programChange(12);
  take.controlChange(7, 100);
  clock.advance(250);
  take.noteOn(60, 101);
  clock.advance(125);
  take.pitchBend(8192 + 2048);
  take.channelPressure(66);
  take.polyPressure(60, 44);
  clock.advance(375);
  take.noteOff(60);
  take.noteOn(67, 55);
  clock.advance(250);
  take.noteOff(67);

  const file = take.toFile();
  assert.ok(file);
  assert.equal(file.bytes[0], 0x4d); // "MThd"
  const parsed = parseMidiBuffer(file.bytes.buffer as ArrayBuffer);
  const evs: PlayEvent[] = parsed.tracks.flatMap((t) => t.playEvents);
  // 480 PPQ at 120 BPM: 1 tick = 1.0417 ms; allow a tick of slop.
  const TICK = 0.00105;
  const ofType = <K extends PlayEvent["type"]>(type: K) =>
    evs.filter((e): e is Extract<PlayEvent, { type: K }> => e.type === type);

  const programs = ofType("program");
  assert.equal(programs.length, 1);
  assert.equal(programs[0].program, 12);
  assert.equal(programs[0].bank, (1 << 7) | 9, "bank folds from the tapped CC0/CC32");

  const ctls: CtlPlayEvent[] = evs.filter(
    (e): e is CtlPlayEvent =>
      e.type === "cc" || e.type === "pitchBend" || e.type === "channelPressure" || e.type === "polyPressure"
  );
  const cc7 = ctls.find((e) => e.type === "cc" && e.controller === 7);
  assert.equal(cc7?.value, 100);

  const noteOns = ofType("noteOn").sort((a, b) => a.sec - b.sec);
  assert.equal(noteOns.length, 2);
  assert.equal(noteOns[0].note, 60);
  assert.equal(noteOns[0].velocity, 101);
  assert.ok(Math.abs(noteOns[0].sec - 0.25) < TICK, `first note at ${noteOns[0].sec}`);
  assert.equal(noteOns[1].note, 67);
  assert.equal(noteOns[1].velocity, 55);
  assert.ok(Math.abs(noteOns[1].sec - 0.75) < TICK, `second note at ${noteOns[1].sec}`);

  const noteOffs = ofType("noteOff");
  assert.equal(noteOffs.length, 2);

  const bend = ctls.find((e) => e.type === "pitchBend");
  assert.equal(bend?.value, 8192 + 2048);
  assert.equal(ctls.find((e) => e.type === "channelPressure")?.value, 66);
  const poly = ctls.find((e) => e.type === "polyPressure");
  assert.equal(poly?.note, 60);
  assert.equal(poly?.value, 44);
});

test("toFile is null before arming or with no events", () => {
  const clock = fakeClock();
  const take = createLiveTakeCapture(clock.now);
  assert.equal(take.toFile(), null);
  take.arm();
  assert.equal(take.toFile(), null);
});
