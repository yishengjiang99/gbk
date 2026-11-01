import test from "node:test";
import assert from "node:assert/strict";
import { nextTransport, STOPPED_TRANSPORT, TRANSPORT_LEAD_MS } from "../shared/jam/signaling.ts";
import { beatsBetween, Metronome } from "../src/jam/metronome.ts";

const start = (now = 1000, bpm = 120, countInBars = 1) => nextTransport(STOPPED_TRANSPORT, { running: true, bpm, beatsPerBar: 4, countInBars }, now);

test("start anchors the count-in at a future time", () => {
  const t = start();
  assert.equal(t.anchorRoomTime, 1000 + TRANSPORT_LEAD_MS); assert.equal(t.anchorBeat, -4); assert.equal(t.revision, 1);
  const b = beatsBetween(t, 0, t.anchorRoomTime + 2001);
  assert.deepEqual(b.map((c) => c.beat), [-4, -3, -2, -1, 0]);
  assert.deepEqual(b.filter((c) => c.countIn).length, 4);
  assert.equal(b[4].roomMs, t.anchorRoomTime + 2000); assert.ok(b[4].accent && b[0].accent && !b[1].accent);
});

test("tempo change re-anchors on a future old-tempo beat; beat count continues", () => {
  const t = start(0, 120, 0); // beat every 500 ms from 400
  const now = 1234; const u = nextTransport(t, { running: true, bpm: 60, beatsPerBar: 4, countInBars: 0 }, now);
  assert.ok(u.anchorRoomTime >= now + TRANSPORT_LEAD_MS);
  assert.equal((u.anchorRoomTime - t.anchorRoomTime) % 500, 0);
  assert.equal(u.anchorBeat, (u.anchorRoomTime - 400) / 500);
  const next = beatsBetween(u, u.anchorRoomTime, u.anchorRoomTime + 2500).map((c) => c.roomMs - u.anchorRoomTime);
  assert.deepEqual(next, [0, 1000, 2000]);
  assert.equal(nextTransport(u, { running: false, bpm: 60, beatsPerBar: 4, countInBars: 0 }, 5000).running, false);
});

test("two clients with different clock offsets click at the same room time", () => {
  const t = start(0, 100, 1);
  const heard: number[][] = [];
  for (const offset of [0, 3721.5]) { // room = local + offset
    let local = 0; const at: number[] = [];
    const m = new Metronome({ roomToLocal: (r) => r - offset, localToRoom: (l) => l + offset, post: (ms, e) => { if (e.type === "noteOn") at.push(ms + offset); }, clear: () => {}, now: () => local });
    local = -offset; m.setTransport(t);
    for (; local < 6000 - offset; local += 50) m.tick();
    heard.push(at);
  }
  assert.ok(heard[0].length >= 9); assert.deepEqual(heard[0], heard[1]);
  assert.equal(new Set(heard[0]).size, heard[0].length, "no duplicate clicks");
});

test("tempo change mid-run keeps old clicks until the new anchor, stop clears", () => {
  let now = 0; const at: number[] = []; let cleared = 0;
  const m = new Metronome({ roomToLocal: (r) => r, localToRoom: (l) => l, post: (ms, e) => { if (e.type === "noteOn") at.push(ms); }, clear: () => { cleared++; }, now: () => now });
  let t = start(0, 120, 0); m.setTransport(t);
  for (; now < 1300; now += 50) m.tick();
  t = nextTransport(t, { running: true, bpm: 240, beatsPerBar: 4, countInBars: 0 }, now); m.setTransport(t);
  for (; now < 3000; now += 50) m.tick();
  assert.deepEqual(at.filter((x) => x < t.anchorRoomTime), [400, 900, 1400]);
  assert.deepEqual(at.filter((x) => x >= t.anchorRoomTime).slice(0, 3), [t.anchorRoomTime, t.anchorRoomTime + 250, t.anchorRoomTime + 500]);
  m.setTransport(nextTransport(t, { running: false, bpm: 240, beatsPerBar: 4, countInBars: 0 }, now)); assert.equal(cleared, 1);
  const n = at.length; for (; now < 4000; now += 50) m.tick(); assert.equal(at.length, n);
});
