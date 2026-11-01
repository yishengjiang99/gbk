import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodePacket, encodePacket, Kind, setHeldBit, heldBit, seqNewer, MAX_PACKET_BYTES, type JamEvent } from "../shared/jam/events.ts";
import { ReplayWindow, REPLAY_WINDOW } from "../src/jam/dedupe.ts";

const ev = (o: Partial<JamEvent>): JamEvent => ({ kind: Kind.NOTE_ON, generation: 3, seq: 1, roomTimeUs: 123_456_789, stream: 0, channel: 0, a: 60, b: 100, noteId: 7, instrumentRevision: 2, clockRevision: 5, ...o });
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fixtures = JSON.parse(readFileSync("test/fixtures/jam/events-v1.json", "utf8")) as { name: string; hex: string; json: Record<string, unknown>[] }[];

test("binary fixtures: encode is byte-identical and decode round-trips (shared with the Swift codec later)", () => {
  const built: Record<string, Uint8Array> = {
    "note-on": encodePacket(ev({})),
    "note-off-with-redundancy": encodePacket(ev({ kind: Kind.NOTE_OFF, seq: 2, b: 0 }), [ev({})]),
    "bend-max-seq-wrap": encodePacket(ev({ kind: Kind.BEND, seq: 0xffffffff, a: 127, b: 127, noteId: 0, roomTimeUs: 2 ** 52 })),
    "snapshot": (() => { const held = new Uint8Array(16); setHeldBit(held, 60, true); setHeldBit(held, 127, true); return encodePacket(ev({ kind: Kind.SNAPSHOT, seq: 9, a: 0, b: 0, noteId: 0, held, sustain: 127 })); })(),
  };
  for (const f of fixtures) {
    assert.equal(hex(built[f.name]), f.hex, f.name);
    const d = decodePacket(Buffer.from(f.hex, "hex"));
    assert.ok(d.ok, f.name);
    assert.deepEqual(d.events.map((e) => ({ ...e, held: e.held ? hex(e.held) : undefined })), f.json.map((j) => ({ ...j, held: j.held ?? undefined })), f.name);
  }
  assert.equal(fixtures.length, 4);
});

test("decode rejects malformed frames", () => {
  const good = encodePacket(ev({}));
  assert.deepEqual(decodePacket(good.slice(0, 10)), { ok: false, error: "SHORT" });
  const v = good.slice(); v[0] = 2; assert.deepEqual(decodePacket(v), { ok: false, error: "VERSION" });
  const k = good.slice(); k[1] = 77; assert.deepEqual(decodePacket(k), { ok: false, error: "KIND" });
  const r = good.slice(); r[16] = 16; assert.deepEqual(decodePacket(r), { ok: false, error: "RANGE" });
  const n = good.slice(); new DataView(n.buffer).setFloat64(8, 1.5, true); assert.deepEqual(decodePacket(n), { ok: false, error: "RANGE" });
  assert.deepEqual(decodePacket(new Uint8Array(MAX_PACKET_BYTES + 1)), { ok: false, error: "SIZE" });
  const five = new Uint8Array(28 * 5); for (let i = 0; i < 5; i++) five.set(good, i * 28); assert.deepEqual(decodePacket(five), { ok: false, error: "SIZE" });
  assert.equal(encodePacket(ev({}), [ev({}), ev({}), ev({}), ev({})]).byteLength, 28 * 4, "redundancy capped at 3");
});

test("held bits and serial sequence arithmetic across wrap", () => {
  const h = new Uint8Array(16); setHeldBit(h, 0, true); setHeldBit(h, 127, true); assert.equal(heldBit(h, 0), 1); assert.equal(heldBit(h, 127), 1); assert.equal(heldBit(h, 64), 0);
  assert.ok(seqNewer(0, 0xffffffff)); assert.ok(!seqNewer(0xffffffff, 0)); assert.ok(seqNewer(5, 4)); assert.ok(!seqNewer(4, 4));
});

test("replay window: reorder accepted once, duplicates and too-old rejected, gaps counted and refilled, wraps", () => {
  const w = new ReplayWindow();
  assert.ok(w.accept(10)); assert.ok(w.accept(13)); assert.equal(w.gaps, 2);
  assert.ok(w.accept(11)); assert.equal(w.gaps, 1); assert.ok(!w.accept(11)); assert.equal(w.duplicates, 1);
  assert.ok(w.accept(10 + REPLAY_WINDOW + 5)); assert.ok(!w.accept(12)); assert.equal(w.tooOld, 1);
  const x = new ReplayWindow(); assert.ok(x.accept(0xfffffffe)); assert.ok(x.accept(1)); assert.ok(x.accept(0xffffffff)); assert.ok(x.accept(0)); assert.ok(!x.accept(0));
});
