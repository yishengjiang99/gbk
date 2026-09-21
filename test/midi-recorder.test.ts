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
  assert.equal(recorder.recordedBatches[0].events.length, 2);
  assert.equal(recorder.recordedBatches[0].events[0].deltaMs, 0);
  assert.equal(recorder.recordedBatches[0].events[1].deltaMs, 100);
  assert.equal(recorder.recordedBatches[0].events[0].status, 0x90);
  assert.equal(recorder.recordedBatches[0].events[0].data1, 60);
  assert.equal(recorder.recordedBatches[0].events[0].data2, 100);
});

test("treats note on with velocity zero as note off", () => {
  const recorder = createMidiRecorder({ batchSize: 4 });
  recorder.start();
  recorder.recordMessage(0, [0x90, 60, 100]);
  recorder.recordMessage(10, [0x90, 60, 0]);
  recorder.stop();

  const events = recorder.recordedBatches[0].events;
  assert.equal(events.length, 2);
  assert.equal(events[1].status, 0x90);
  assert.equal(events[1].data2, 0);
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
  assert.equal(events[1].status, 0xb0);
  assert.equal(events[1].data1, 64);
  assert.equal(events[1].data2, 127);
  assert.equal(events[2].data2, 0);
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

test("device disconnection leaves no stuck notes when input stops", () => {
  const recorder = createMidiRecorder({ batchSize: 4 });
  recorder.start();
  recorder.recordMessage(0, [0x90, 60, 100]);
  recorder.recordMessage(0, [0x90, 64, 100]);
  // Simulate disconnect by stopping without matching note-offs.
  recorder.stop();

  const snapshot = recorder.snapshot();
  assert.equal(snapshot.activeNotes.length, 2);
  assert.equal(snapshot.state, "stopped");
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
    assert.equal(events[i].data1, 60 + i);
    assert.equal(events[i].deltaMs, i * 10);
  }
});
