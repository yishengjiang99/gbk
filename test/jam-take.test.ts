import test from "node:test";
import assert from "node:assert/strict";
import { Kind, type JamEvent } from "../shared/jam/events.ts";
import { nextTransport, STOPPED_TRANSPORT } from "../shared/jam/signaling.ts";
import { TakeRecorder } from "../src/jam/take.ts";
import { parseSmf, serializeSmf } from "../src/workstation/smf.ts";

const ev = (kind: number, ms: number, seq: number, a: number, noteId: number): JamEvent => ({ kind: kind as JamEvent["kind"], generation: 1, seq, roomTimeUs: ms * 1000, stream: 0, channel: 0, a, b: 100, noteId, instrumentRevision: 1, clockRevision: 1 });

test("take: per-player tracks on the metronome grid, dupes ignored, MIDI round-trips", () => {
  const t = nextTransport(STOPPED_TRANSPORT, { running: true, bpm: 120, beatsPerBar: 4, countInBars: 1 }, 0); // beat 0 at 400 + 2000
  const r = new TakeRecorder(); r.start(2500, t);
  r.add("a", ev(Kind.NOTE_ON, 2400 + 2000, 1, 60, 1)); r.add("a", ev(Kind.NOTE_ON, 2400 + 2000, 1, 60, 1)); // redundant copy
  r.add("a", ev(Kind.NOTE_OFF, 2400 + 2500, 2, 60, 1));
  r.add("b", ev(Kind.NOTE_ON, 2400 + 1000, 7, 67, 9)); // held at stop
  r.add("b", ev(Kind.NOTE_ON, 100, 8, 70, 10)); // before the take: ignored
  r.stop(2400 + 3000);
  const p = r.toProject(new Map([["a", { name: "Ann", bank: 0, program: 0 }], ["b", { name: "Bo", bank: 0, program: 33 }]]));
  assert.equal(p.tracks.length, 2); assert.deepEqual(p.tracks.map((x) => x.name), ["Ann", "Bo"]);
  const ann = p.notes.filter((n) => n.trackId === p.tracks[0].id), bo = p.notes.filter((n) => n.trackId === p.tracks[1].id);
  assert.deepEqual(ann.map((n) => [n.tick, n.duration, n.pitch]), [[4 * 480, 480, 60]]); // bar 2, beat 1
  assert.deepEqual(bo.map((n) => [n.tick, n.duration]), [[2 * 480, 4 * 480]]);
  assert.equal(p.tempos[0].microPerQuarter, 500000);
  const back = parseSmf(serializeSmf(p));
  assert.equal(back.notes.length, 2); assert.deepEqual(back.notes.map((n) => n.pitch).sort(), [60, 67]);
});
