import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Kind, setHeldBit, type JamEvent } from "../shared/jam/events.ts";
import { NoteReconciler } from "../src/jam/reconciler.ts";
import { ReceiveScheduler } from "../src/jam/receive-scheduler.ts";
import { ClockEstimator } from "../src/jam/clock.ts";
import { InputRouter } from "../src/jam/input-router.ts";
import { Sf2ProcessorCore, LIVE_QUEUE_CAPACITY } from "../src/sf2-processor-core.ts";
import { parseSoundFont, resolveInstrument } from "../src/audio/soundfont-loader.ts";
import { synthEvent } from "../src/synth-ingress.ts";
import type { SynthEvent } from "../src/sf2-renderer.ts";

const e = (o: Partial<JamEvent>): JamEvent => ({ kind: Kind.NOTE_ON, generation: 1, seq: 1, roomTimeUs: 0, stream: 0, channel: 0, a: 60, b: 100, noteId: 1, instrumentRevision: 0, clockRevision: 0, ...o });
const kinds = (rs: { event: JamEvent }[]) => rs.map((r) => `${r.event.kind === Kind.NOTE_ON ? "on" : r.event.kind === Kind.NOTE_OFF ? "off" : r.event.kind === Kind.CC ? `cc${r.event.a}` : r.event.kind}:${r.event.a}`);

test("reconciler: duplicate attack, release before attack (tombstone), stale release vs newer same-key note", () => {
  const r = new NoteReconciler();
  assert.deepEqual(kinds(r.apply(e({ seq: 1, noteId: 1 }))), ["on:60"]);
  assert.deepEqual(kinds(r.apply(e({ seq: 1, noteId: 1 }))), [], "duplicate");
  // retrigger: note 2 on the same key releases note 1 first
  assert.deepEqual(kinds(r.apply(e({ seq: 3, noteId: 2 }))), ["off:60", "on:60"]);
  // note 1's late release must not kill note 2
  assert.deepEqual(kinds(r.apply(e({ kind: Kind.NOTE_OFF, seq: 2, noteId: 1, b: 0 }))), []);
  assert.equal(r.heldCount, 1);
  assert.deepEqual(kinds(r.apply(e({ kind: Kind.NOTE_OFF, seq: 4, noteId: 2, b: 0 }))), ["off:60"]);
  // release arrives before its attack: attack is then suppressed
  assert.deepEqual(kinds(r.apply(e({ kind: Kind.NOTE_OFF, seq: 6, noteId: 3, a: 62, b: 0 }))), []);
  assert.deepEqual(kinds(r.apply(e({ seq: 5, noteId: 3, a: 62 }))), []);
  assert.equal(r.heldCount, 0);
  // velocity-0 note on is a release
  r.apply(e({ seq: 7, noteId: 4, a: 64 })); assert.deepEqual(kinds(r.apply(e({ seq: 8, noteId: 4, a: 64, b: 0 }))), ["off:64"]);
});

test("reconciler: snapshot watermark releases lost releases but never resurrects or kills newer notes", () => {
  const r = new NoteReconciler();
  r.apply(e({ seq: 1, noteId: 1, a: 60 })); r.apply(e({ seq: 5, noteId: 2, a: 64 }));
  const held = new Uint8Array(16); setHeldBit(held, 67, true); // 67's attack was lost: not synthesized
  const out = r.apply(e({ kind: Kind.SNAPSHOT, seq: 3, a: 0, b: 0, held, sustain: 127 }));
  assert.deepEqual(kinds(out), ["off:60", "cc64:64"], "60 released (as of 3 it was up); 64 (seq 5 > watermark) kept");
  assert.deepEqual(r.heldPitches(), [64]);
  // a later, stale sustain-up from before the snapshot is ignored
  assert.deepEqual(kinds(r.apply(e({ kind: Kind.CC, seq: 2, a: 64, b: 0, noteId: 0 }))), []);
  assert.deepEqual(kinds(r.releaseAll()), ["off:64", "cc64:64", "cc66:66", "cc123:123"]);
});

class FakeSink { out: { t: number | null; e: SynthEvent }[] = []; clears = 0; schedule(t: number | null, e: SynthEvent) { this.out.push({ t, e }); } clear() { this.clears++; } }

test("receive scheduler: per-peer budget, late attacks dropped, late releases applied, commit order kept", () => {
  let now = 1000; const sink = new FakeSink();
  const s = new ReceiveScheduler(sink, (room) => room, () => now, { jitterAllowanceMs: 5 });
  // 10 events with 10 ms transit
  for (let i = 1; i <= 10; i++) { now = 1000 + i * 20; s.receive([e({ seq: i * 2 - 1, noteId: i, roomTimeUs: (now - 10) * 1000 })]); now += 1; s.receive([e({ kind: Kind.NOTE_OFF, seq: i * 2, noteId: i, b: 0, roomTimeUs: (now - 10) * 1000 })]); }
  assert.ok(s.budgetMs >= 15 && s.budgetMs <= 17, `budget ${s.budgetMs}`);
  const ons = sink.out.filter((o) => o.e.type === "noteOn");
  assert.equal(ons.length, 10); assert.ok(ons.every((o) => o.t !== null && o.t > 0));
  // An attack 200 ms late is dropped; its release still goes out ASAP.
  now = 5000; sink.out = [];
  s.receive([e({ seq: 100, noteId: 50, a: 70, roomTimeUs: 4800 * 1000 })]);
  assert.equal(sink.out.length, 0); assert.equal(s.stats.lateAttacksDropped, 1);
  s.receive([e({ seq: 101, noteId: 51, a: 71, roomTimeUs: 4995 * 1000 })]);
  s.receive([e({ kind: Kind.NOTE_OFF, seq: 102, noteId: 51, a: 71, b: 0, roomTimeUs: 4700 * 1000 })]);
  const off = sink.out.find((o) => o.e.type === "noteOff"); assert.ok(off); assert.equal(off.t, null, "late release applied immediately");
  // committed times never go backwards for a source
  const ts = sink.out.map((o) => o.t).filter((t): t is number => t !== null); assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
});

test("receive scheduler: lease releases a silent source; heartbeats keep a held chord alive; generation change resets", () => {
  let now = 0; const sink = new FakeSink(); const s = new ReceiveScheduler(sink, (r) => r, () => now, { leaseMs: 1000 });
  s.setGeneration(1);
  s.receive([e({ seq: 1, noteId: 1, roomTimeUs: 0 })]);
  for (let t = 250; t <= 3000; t += 250) { now = t; const held = new Uint8Array(16); setHeldBit(held, 60, true); s.receive([e({ kind: Kind.SNAPSHOT, seq: 1, a: 0, b: 0, noteId: 0, held, roomTimeUs: t * 1000 })]); s.checkLease(); }
  assert.equal(s.reconciler.heldCount, 1, "held note survives while heartbeats continue");
  now = 4100; s.checkLease(); assert.equal(s.stats.leaseExpiries, 1); assert.equal(s.reconciler.heldCount, 0);
  assert.ok(sink.out.some((o) => o.e.type === "noteOff" && o.t === null));
  s.receive([e({ seq: 9, noteId: 9, generation: 1 })]); assert.equal(s.reconciler.heldCount, 1);
  s.setGeneration(2); assert.equal(s.reconciler.heldCount, 0, "new generation releases the old stream");
  s.receive([e({ seq: 10, noteId: 10, generation: 1 })]); assert.equal(s.stats.staleGeneration, 1);
});

test("clock estimator: recovers a known offset, uncertainty covers asymmetry, resets after sleep", () => {
  const c = new ClockEstimator(); const offset = 5000; let t = 0;
  for (let i = 0; i < 16; i++) { const up = i % 4 === 0 ? 40 : 3, down = 3 + (i % 3); t += 1000; c.add({ t0: t, ts: t + up + offset, t3: t + up + down }); }
  assert.ok(Math.abs(c.offsetMs - offset) <= 2, `offset ${c.offsetMs}`);
  assert.ok(c.uncertaintyMs >= 3 && c.uncertaintyMs < 10, `uncertainty ${c.uncertaintyMs}`);
  // asymmetric path (10 up, 2 down): estimate is off by (10-2)/2 = 4 and uncertainty is at least that
  const a = new ClockEstimator(); for (let i = 0; i < 8; i++) a.add({ t0: i * 100, ts: i * 100 + 10 + 7, t3: i * 100 + 12 });
  assert.equal(Math.round(Math.abs(a.offsetMs - 7)), 4); assert.ok(a.uncertaintyMs >= 4 - 1e-9 + 2);
  const rev = c.revision; c.add({ t0: t + 60_000, ts: t + 60_000 + offset + 2, t3: t + 60_004 }); assert.notEqual(c.revision, rev); assert.ok(!c.add({ t0: 10, ts: 0, t3: 5 }));
});

test("input router: one monitor + one send per event, raw releases/pedals preserved, retrigger pairs ids, snapshot state", () => {
  const mon: SynthEvent[] = []; const sent: { e: JamEvent; r: JamEvent[] }[] = [];
  const r = new InputRouter({ monitor: (m) => mon.push(m), send: (e, red) => sent.push({ e, r: red }), localToRoomMs: (t) => t + 1000, clockRevision: () => 3, generation: () => 2, instrumentRevision: () => 1 });
  r.noteOn(60, 90, 10); r.controlChange(64, 127, 11); r.noteOff(60, 12);
  assert.equal(mon.length, 3); assert.equal(sent.length, 3);
  assert.equal(sent[2].e.kind, Kind.NOTE_OFF, "release sent raw even with sustain down");
  assert.equal(sent[0].e.roomTimeUs, 1_010_000); assert.equal(sent[2].e.noteId, sent[0].e.noteId);
  assert.equal(sent[2].r.length, 2, "recent critical events ride along");
  r.noteOn(62, 90, 20); r.noteOn(62, 80, 21);
  const last = sent.slice(-3).map((s) => s.e.kind); assert.deepEqual(last, [Kind.NOTE_ON, Kind.NOTE_OFF, Kind.NOTE_ON]);
  const snap = r.snapshot(30); assert.equal(snap.sustain, 127); assert.equal((snap.held![62 >> 3] >> (62 & 7)) & 1, 1);
  // Web MIDI bytes keep their capture timestamp
  r.midi(new Uint8Array([0x93, 64, 100]), 555.5, 1); assert.equal(sent[sent.length - 1].e.roomTimeUs, 1_555_500); assert.equal(sent[sent.length - 1].e.channel, 0);
  r.panic(40); assert.equal(r.heldNotes.length, 0); assert.equal(sent[sent.length - 1].e.kind, Kind.PANIC);
});

const SF = parseSoundFont(new Uint8Array(readFileSync("public/static/GeneralUser-GS.sf2")), "GeneralUser-GS.sf2");
const firstNonZero = (a: Float32Array) => a.findIndex((v) => Math.abs(v) > 1e-7);

test("worklet live queue: an early event sounds at its exact frame inside a quantum; sequence path unaffected", () => {
  const core = new Sf2ProcessorCore(48000); core.engine.effectsEnabled = false;
  core.onMsg(synthEvent.setPreset(resolveInstrument(SF.sf, 0, 0, 0).regions, 0));
  const Q = 128; const L = new Float32Array(Q * 4), R = new Float32Array(Q * 4);
  core.onMsg({ type: "liveEvent", frame: 1000 + 200, event: synthEvent.noteOn(0, 60, 120) } as unknown as SynthEvent);
  for (let b = 0; b < 4; b++) core.process(L.subarray(b * Q, (b + 1) * Q), R.subarray(b * Q, (b + 1) * Q), 1000 + b * Q);
  // reference: same note dispatched at frame 0 of a fresh engine (sample attack may start with near-silence)
  const ref = new Sf2ProcessorCore(48000); ref.engine.effectsEnabled = false; ref.onMsg(synthEvent.setPreset(resolveInstrument(SF.sf, 0, 0, 0).regions, 0)); ref.onMsg(synthEvent.noteOn(0, 60, 120));
  const RL = new Float32Array(Q * 4); for (let b = 0; b < 4; b++) ref.process(RL.subarray(b * Q, (b + 1) * Q), new Float32Array(Q), b * Q);
  const d0 = firstNonZero(RL); const onset = firstNonZero(L);
  assert.equal(onset - d0, 200, `onset ${onset}, reference ${d0}`);
  for (let i = 0; i < 64; i++) assert.equal(L[200 + i], RL[i], "same samples, shifted by exactly 200 frames");
  assert.equal(core.liveStats.applied, 1); assert.equal(core.liveStats.late, 0);
  // late event: applied at the start of the next quantum and counted
  core.onMsg({ type: "liveEvent", frame: 900, event: synthEvent.noteOff(0, 60) } as unknown as SynthEvent);
  core.process(new Float32Array(Q), new Float32Array(Q), 1512); assert.equal(core.liveStats.late, 1);
});

test("worklet live queue: sorted, bounded, attacks dropped when full, releases bypass, panic clears and silences", () => {
  const core = new Sf2ProcessorCore(48000); core.engine.effectsEnabled = false;
  core.onMsg(synthEvent.setPreset(resolveInstrument(SF.sf, 0, 0, 0).regions, 0));
  for (let i = 0; i < LIVE_QUEUE_CAPACITY; i++) core.enqueueLive(1e9 - i, synthEvent.controlChange(0, 1, i % 128));
  assert.equal(core.liveQueued, LIVE_QUEUE_CAPACITY);
  core.enqueueLive(1e9, synthEvent.noteOn(0, 60, 100)); assert.equal(core.liveStats.droppedAttacks, 1);
  core.enqueueLive(1e9, synthEvent.noteOff(0, 60)); assert.equal(core.liveStats.bypassed, 1);
  core.onMsg({ type: "livePanic" } as SynthEvent); assert.equal(core.liveQueued, 0);
  core.onMsg(synthEvent.noteOn(0, 60, 120)); const L = new Float32Array(256), R = new Float32Array(256); core.process(L, R, 0); assert.ok(firstNonZero(L) >= 0);
  core.panic(); const L2 = new Float32Array(2048), R2 = new Float32Array(2048); core.process(L2, R2, 256); assert.ok(Math.max(...L2.slice(1024).map(Math.abs)) < 1e-4, "silent after panic");
  // offline/sequence path: no currentFrame argument still works
  const c2 = new Sf2ProcessorCore(48000); c2.onMsg(synthEvent.setPreset(resolveInstrument(SF.sf, 0, 0, 0).regions, 0)); c2.onMsg({ type: "setSequence", events: [{ ...synthEvent.noteOn(0, 60, 120), frame: 50 }] } as unknown as SynthEvent);
  c2.engine.effectsEnabled = false; const L3 = new Float32Array(512); for (let b = 0; b < 4; b++) c2.process(L3.subarray(b * 128, (b + 1) * 128), new Float32Array(128));
  const ref = new Sf2ProcessorCore(48000); ref.engine.effectsEnabled = false; ref.onMsg(synthEvent.setPreset(resolveInstrument(SF.sf, 0, 0, 0).regions, 0)); ref.onMsg(synthEvent.noteOn(0, 60, 120));
  const RL = new Float32Array(512); for (let b = 0; b < 4; b++) ref.process(RL.subarray(b * 128, (b + 1) * 128), new Float32Array(128));
  assert.equal(firstNonZero(L3) - firstNonZero(RL), 50, "sequence event still lands on its frame");
});
