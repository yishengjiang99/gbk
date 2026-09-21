import test from "node:test";
import assert from "node:assert/strict";
import { createMidiRecorder } from "../src/midi-recorder.ts";

test("records note on and note off with relative timing", () => {
  const recorder = createMidiRecorder({ batchSize: 4 });
  recorder.start();
  recorder.recordMessage(1000, [0x90, 60, 100]);
  recorder.recordMessage(1100, [0x80, 60, 0]);
  recorder.stop();

  assert.equal(recorder.recordedBatches.length, 1);
  const events = recorder.recordedBatches[0].events;
  assert.equal(events.length, 2);
  assert.equal(events[0].deltaMs, 0);
  assert.deepEqual(events[0].bytes, [0x90, 60, 100]);
  assert.equal(events[1].deltaMs, 100);
  assert.deepEqual(events[1].bytes, [0x80, 60, 0]);
});

test("treats note on with velocity zero as note off", () => {
  const recorder = createMidiRecorder({ batchSize: 4 });
  recorder.start();
  recorder.recordMessage(0, [0x90, 60, 100]);
  recorder.recordMessage(10, [0x90, 60, 0]);
  recorder.stop();

  const events = recorder.recordedBatches[0].events;
  assert.equal(events.length, 2);
  assert.deepEqual(events[1].bytes, [0x90, 60, 0]);
  assert.equal(recorder.snapshot().activeNotes.length, 0);
});

test("tracks overlapping notes of the same pitch on different channels", () => {
  const recorder = createMidiRecorder({ batchSize: 8 });
  recorder.start();
  recorder.recordMessage(0, [0x91, 60, 100]);
  recorder.recordMessage(0, [0x92, 60, 80]);
  recorder.recordMessage(10, [0x81, 60, 0]);
  recorder.stop();

  const snapshot = recorder.snapshot();
  assert.equal(snapshot.activeNotes.length, 1);
  assert.equal(snapshot.activeNotes[0].channel, 2);
  assert.equal(snapshot.activeNotes[0].velocity, 80);
});

test("sustain pedal is recorded as a controller event", () => {
  const recorder = createMidiRecorder({ batchSize: 4 });
  recorder.start();
  recorder.recordMessage(0, [0x90, 60, 100]);
  recorder.recordMessage(5, [0xb0, 64, 127]);
  recorder.recordMessage(15, [0xb0, 64, 0]);
  recorder.stop();

  const events = recorder.recordedBatches[0].events;
  assert.equal(events.length, 3);
  assert.deepEqual(events[1].bytes, [0xb0, 64, 127]);
  assert.deepEqual(events[2].bytes, [0xb0, 64, 0]);
});

test("channel isolation keeps notes separate", () => {
  const recorder = createMidiRecorder({ batchSize: 16 });
  recorder.start();
  for (let ch = 0; ch < 16; ch++) {
    recorder.recordMessage(ch, [0x90 | ch, 60 + ch, 100]);
  }
  recorder.stop();

  assert.equal(recorder.snapshot().activeNotes.length, 16);
});

test("all notes off clears active notes for the channel", () => {
  const recorder = createMidiRecorder({ batchSize: 16 });
  recorder.start();
  recorder.recordMessage(0, [0x90, 60, 100]);
  recorder.recordMessage(0, [0x91, 64, 100]);
  recorder.recordMessage(10, [0xb0, 123, 0]);
  recorder.stop();

  const snapshot = recorder.snapshot();
  assert.equal(snapshot.activeNotes.length, 1);
  assert.equal(snapshot.activeNotes[0].channel, 1);
});

test("out-of-order timestamps are recorded as given", () => {
  const recorder = createMidiRecorder({ batchSize: 4 });
  recorder.start();
  recorder.recordMessage(200, [0x90, 60, 100]);
  recorder.recordMessage(100, [0x80, 60, 0]);
  recorder.stop();

  const events = recorder.recordedBatches[0].events;
  assert.equal(events[0].deltaMs, 0);
  assert.equal(events[1].deltaMs, -100);
});

test("flush pushes partial batch while recording", () => {
  const recorder = createMidiRecorder({ batchSize: 100 });
  recorder.start();
  recorder.recordMessage(0, [0x90, 60, 100]);
  recorder.flush();
  assert.equal(recorder.recordedBatches.length, 1);
  assert.equal(recorder.recordedBatches[0].events.length, 1);
});

test("stop flushes partial batch", () => {
  const recorder = createMidiRecorder({ batchSize: 100 });
  recorder.start();
  recorder.recordMessage(0, [0x90, 60, 100]);
  recorder.recordMessage(10, [0x80, 60, 0]);
  recorder.stop();

  assert.equal(recorder.recordedBatches.length, 1);
  assert.equal(recorder.recordedBatches[0].events.length, 2);
  assert.equal(recorder.pendingBatch.length, 0);
});

test("reset clears state and batches", () => {
  const recorder = createMidiRecorder({ batchSize: 4 });
  recorder.start();
  recorder.recordMessage(0, [0x90, 60, 100]);
  recorder.recordMessage(10, [0x80, 60, 0]);
  recorder.reset();

  assert.equal(recorder.state, "idle");
  assert.equal(recorder.recordedBatches.length, 0);
  assert.equal(recorder.pendingBatch.length, 0);
  assert.equal(recorder.snapshot().activeNotes.length, 0);
});

test("batches encode events in correct order", () => {
  const recorder = createMidiRecorder({ batchSize: 2 });
  recorder.start();
  for (let i = 0; i < 5; i++) {
    recorder.recordMessage(i * 10, [0x90, 60 + i, 100]);
  }
  recorder.stop();

  const events = recorder.recordedBatches.flatMap((b) => b.events);
  assert.equal(events.length, 5);
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(events[i].bytes, [0x90, 60 + i, 100]);
    assert.equal(events[i].deltaMs, i * 10);
  }
});

test("records system realtime messages as single bytes", () => {
  const recorder = createMidiRecorder({ batchSize: 4 });
  recorder.start();
  recorder.recordMessage(0, [0xf8]);
  recorder.recordMessage(10, [0xfa]);
  recorder.recordMessage(20, [0xfc]);
  recorder.stop();

  const events = recorder.recordedBatches[0].events;
  assert.equal(events.length, 3);
  assert.deepEqual(events[0].bytes, [0xf8]);
  assert.deepEqual(events[1].bytes, [0xfa]);
  assert.deepEqual(events[2].bytes, [0xfc]);
});

test("records song position pointer", () => {
  const recorder = createMidiRecorder({ batchSize: 4 });
  recorder.start();
  recorder.recordMessage(0, [0xf2, 0x10, 0x00]);
  recorder.stop();

  const events = recorder.recordedBatches[0].events;
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].bytes, [0xf2, 0x10, 0x00]);
});

test("records complete sysex messages", () => {
  const recorder = createMidiRecorder({ batchSize: 4 });
  recorder.start();
  recorder.recordMessage(0, [0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7]);
  recorder.stop();

  const events = recorder.recordedBatches[0].events;
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].bytes, [0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7]);
});

test("flushes incomplete sysex on stop", () => {
  const recorder = createMidiRecorder({ batchSize: 4 });
  recorder.start();
  recorder.recordMessage(0, [0xf0, 0x7e, 0x7f]);
  recorder.stop();

  const events = recorder.recordedBatches[0].events;
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].bytes, [0xf0, 0x7e, 0x7f]);
});

test("handles running status for channel voice messages", () => {
  const recorder = createMidiRecorder({ batchSize: 4 });
  recorder.start();
  recorder.recordMessage(0, [0x90, 60, 100]);
  recorder.recordMessage(10, [60, 0]);
  recorder.stop();

  const events = recorder.recordedBatches[0].events;
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].bytes, [0x90, 60, 100]);
  assert.deepEqual(events[1].bytes, [0x90, 60, 0]);
});

test("typed array encodes byte count and preserves all bytes", () => {
  const recorder = createMidiRecorder({ batchSize: 2 });
  recorder.start();
  recorder.recordMessage(0, [0xf0, 0x01, 0x02, 0xf7]);
  recorder.recordMessage(1, [0x90, 60, 100]);
  recorder.stop();

  const typed = (recorder as unknown as { buildTypedEvents(): Float64Array }).buildTypedEvents();
  const stride = 6;
  assert.equal(typed.length, 2 * stride);
  assert.equal(typed[0], 0);
  assert.equal(typed[1], 4);
  assert.equal(typed[3], 0xf0);
  assert.equal(typed[4], 0x01);
  assert.equal(typed[5], 0x02);
  assert.equal(typed[stride + 0], 1);
  assert.equal(typed[stride + 1], 3);
  assert.equal(typed[stride + 3], 0x90);
  assert.equal(typed[stride + 4], 60);
  assert.equal(typed[stride + 5], 100);
});
