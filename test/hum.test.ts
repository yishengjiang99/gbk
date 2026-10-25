import assert from "node:assert/strict";
import test from "node:test";

import { decodeNotes, runBasicPitch, transcribeSamples, BP_SAMPLE_RATE } from "../src/hum/transcribe-core.ts";
import { amplitudeToVelocity, humToOps, nextMelodicChannel, HUM_TRACK_NAME } from "../src/hum/notes-to-ops.ts";
import { emptyProject, DEFAULT_MIX, type Track } from "../src/workstation/model.ts";
import { applyOps, validateOps } from "../src/workstation/ops.ts";

const N_BINS = 88;
const C4_IDX = 60 - 21; // model freq index for MIDI 60

function blankFrames(n: number): number[][] {
  return Array.from({ length: n }, () => new Array<number>(N_BINS).fill(0));
}

test("decoder: a held band with an onset spike decodes to one note", () => {
  const frames = blankFrames(120);
  const onsets = blankFrames(120);
  for (let f = 20; f < 80; f++) frames[f][C4_IDX] = 0.9;
  onsets[20][C4_IDX] = 1.0;
  const notes = decodeNotes(frames, onsets);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].pitchMidi, 60);
  assert.ok(Math.abs(notes[0].startSec - (20 * 256) / BP_SAMPLE_RATE) < 0.03, `start ${notes[0].startSec}`);
  assert.ok(Math.abs(notes[0].endSec - notes[0].startSec - (60 * 256) / BP_SAMPLE_RATE) < 0.06, `dur ${notes[0].endSec - notes[0].startSec}`);
  assert.ok(notes[0].amplitude > 0.8);
});

test("decoder: silence decodes to no notes", () => {
  assert.deepEqual(decodeNotes(blankFrames(50), blankFrames(50)), []);
  assert.deepEqual(decodeNotes([], []), []);
});

test("windowing: frames are stitched across windows and trimmed to the audio length", async () => {
  const samples = new Float32Array(BP_SAMPLE_RATE * 3); // 3 s
  const runWindow = async (_win: Float32Array, index: number) => {
    const note = new Float32Array(172 * N_BINS);
    const onset = new Float32Array(172 * N_BINS);
    // Like real model output: silence before the attack, full energy after.
    for (let r = index === 0 ? 20 : 0; r < 172; r++) note[r * N_BINS + C4_IDX] = 0.95;
    if (index === 0) onset[20 * N_BINS + C4_IDX] = 1.0; // onset at window row 20 -> stitched frame 5
    return { note, onset };
  };
  const { frames, onsets } = await runBasicPitch(samples, runWindow);
  assert.equal(frames.length, Math.floor((samples.length * 86) / BP_SAMPLE_RATE)); // 258
  assert.equal(onsets.length, 258);
  assert.ok(Math.abs(frames[100][C4_IDX] - 0.95) < 1e-6);

  const notes = await transcribeSamples(samples, runWindow);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].pitchMidi, 60);
  assert.ok(Math.abs(notes[0].startSec - (5 * 256) / BP_SAMPLE_RATE) < 0.03, `start ${notes[0].startSec}`);
  assert.ok(notes[0].endSec > 2.8, `end ${notes[0].endSec}`);
});

test("windowing: a sub-window take still yields the exact frame count", async () => {
  const samples = new Float32Array(BP_SAMPLE_RATE / 2); // 0.5 s
  const runWindow = async () => ({ note: new Float32Array(172 * N_BINS), onset: new Float32Array(172 * N_BINS) });
  const { frames } = await runBasicPitch(samples, runWindow);
  assert.equal(frames.length, 43);
  assert.deepEqual(decodeNotes(frames, frames), []);
});

test("velocity: amplitude maps into 1..127 with a sane default", () => {
  assert.equal(amplitudeToVelocity(1), 127);
  assert.equal(amplitudeToVelocity(0), 1);
  assert.equal(amplitudeToVelocity(0.5), 64);
  assert.equal(amplitudeToVelocity(undefined), 102);
  assert.equal(amplitudeToVelocity(Number.NaN), 102);
});

test("conversion: seconds map through the project tempo map into ticks", () => {
  const p = emptyProject(); // 480 ppq, 120 bpm default
  const ops = humToOps(p, [{ pitchMidi: 60, startSec: 0.5, endSec: 1.0, amplitude: 0.5 }], "trk_hum");
  assert.equal(ops.length, 2);
  assert.equal(ops[0].op, "addTrack");
  assert.equal(ops[1].op, "addNotes");
  if (ops[1].op !== "addNotes") throw new Error("unreachable");
  assert.equal(ops[1].notes.length, 1);
  const n = ops[1].notes[0];
  assert.equal(n.tick, 480); // 0.5 s at 120 bpm = 1 beat
  assert.equal(n.duration, 480);
  assert.equal(n.pitch, 60);
  assert.equal(n.velocity, 64);
  assert.equal(n.trackId, "trk_hum");

  const slow = emptyProject();
  slow.tempos = [{ tick: 0, microPerQuarter: 1_000_000 }]; // 60 bpm
  const ops2 = humToOps(slow, [{ pitchMidi: 62, startSec: 0.5, endSec: 0.75, amplitude: 1 }], "trk_hum2");
  if (ops2[1].op !== "addNotes") throw new Error("unreachable");
  assert.equal(ops2[1].notes[0].tick, 240); // 0.5 s at 60 bpm = half a beat
  assert.equal(ops2[1].notes[0].duration, 120);
});

test("conversion: ops validate and apply into a real project", () => {
  const p = emptyProject();
  const notes = [
    { pitchMidi: 60, startSec: 0, endSec: 0.5, amplitude: 0.9 },
    { pitchMidi: 64, startSec: 0.5, endSec: 1.0, amplitude: 0.7 },
    { pitchMidi: 67, startSec: 1.0, endSec: 1.5, amplitude: 0.8 },
  ];
  const ops = humToOps(p, notes, "trk_hum");
  assert.doesNotThrow(() => validateOps(p, ops));
  const next = applyOps(p, ops);
  const track = next.tracks.find((t) => t.id === "trk_hum");
  assert.ok(track);
  assert.equal(track?.name, HUM_TRACK_NAME);
  assert.equal(track?.role, "melody");
  const prog = next.programs.find((g) => g.trackId === "trk_hum");
  assert.equal(prog?.program, 0); // Acoustic Grand Piano
  assert.equal(next.notes.filter((n) => n.trackId === "trk_hum").length, 3);
  assert.equal(next.endTick, 1440);
});

test("conversion: channel selection skips used channels and the drum channel", () => {
  const p = emptyProject();
  const mk = (channel: number): Track => ({ id: `t${channel}`, name: `x${channel}`, channel, color: "#000", mix: { ...DEFAULT_MIX }, visible: true });
  assert.equal(nextMelodicChannel(p), 0);
  p.tracks.push(mk(0), mk(1));
  assert.equal(nextMelodicChannel(p), 2);
  for (const c of [2, 3, 4, 5, 6, 7, 8]) p.tracks.push(mk(c));
  assert.equal(nextMelodicChannel(p), 10); // 9 = GM drums
});

test("conversion: an empty take produces no ops", () => {
  assert.deepEqual(humToOps(emptyProject(), [], "trk_hum"), []);
});
