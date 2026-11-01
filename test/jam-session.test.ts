// Session controller with injected fake signaling, fake peer links (seeded loss/delay/dup) and fake audio, on a manual clock.
import test from "node:test";
import assert from "node:assert/strict";
import { JamSession, type PeerCallbacks, type PeerLinksLike, type SignalingLike } from "../src/jam/session.ts";
import type { JamAudioOut } from "../src/jam/audio.ts";
import type { RoomSnapshot, ServerFrame, ClientFrame } from "../shared/jam/signaling.ts";
import type { ControlMessage } from "../shared/jam/events.ts";
import type { SynthEvent } from "../src/sf2-renderer.ts";
import { SignalingClient, type WsLike } from "../src/jam/signaling-client.ts";

class Clock { t = 0; timers: { at: number; f: () => void; every?: number; id: number }[] = []; n = 0;
  now = () => this.t;
  every = (f: () => void, ms: number) => { const id = ++this.n; this.timers.push({ at: this.t + ms, f, every: ms, id }); return () => { this.timers = this.timers.filter((x) => x.id !== id); }; };
  after = (f: () => void, ms: number) => { const id = ++this.n; this.timers.push({ at: this.t + ms, f, id }); return id; };
  advance(ms: number) { const end = this.t + ms; for (;;) { this.timers.sort((a, b) => a.at - b.at); const x = this.timers[0]; if (!x || x.at > end) break; this.t = x.at; if (x.every) x.at += x.every; else this.timers.shift(); x.f(); } this.t = end; } }

class FakeAudio implements JamAudioOut {
  posts: { pid: string; t: number | null; e: SynthEvent }[] = []; engines = new Set<string>(); panics = 0; presets = new Map<string, number>();
  ensure(pid: string) { this.engines.add(pid); } async setInstrument(pid: string, _b: number, p: number) { this.presets.set(pid, p); return `P${p}`; }
  post(pid: string, t: number | null, e: SynthEvent) { this.posts.push({ pid, t, e }); } clear() {} panic() { this.panics++; } remove(pid: string) { this.engines.delete(pid); }
  setGain() {} level() { return 0; } info() { return { state: "running", sampleRate: 48000, baseLatencyMs: 0, outputLatencyMs: 0 }; } close() {}
  heard(pid: string, type: string) { return this.posts.filter((p) => p.pid === pid && p.e.type === type); }
}

/** Fake room: server state + signaling + data links between sessions. */
class FakeRoom {
  sessions = new Map<string, { sig: FakeSignaling; peers: FakeLinks; s?: JamSession; gen: number }>();
  epoch = 1; host = "pa"; rand = 1; loss = 0; dup = 0; delayMs = 10;
  constructor(public clock: Clock) {}
  snapshot(): RoomSnapshot { return { roomId: "r1", epoch: this.epoch, serverEpoch: "e1", hostId: this.host, maxParticipants: 4, locked: false, expiresAt: 1e12, participants: [...this.sessions].map(([pid, v]) => ({ participantId: pid, name: pid, role: pid === this.host ? "host" : "member", state: "ready", generation: v.gen, connected: v.sig.open, instrumentRevision: 0 })) }; }
  random() { this.rand = (this.rand * 16807) % 2147483647; return this.rand / 2147483647; }
  broadcast() { for (const v of this.sessions.values()) if (v.sig.open) v.sig.deliver({ type: "snapshot", snapshot: this.snapshot() }); }
  add(pid: string, audio: FakeAudio) {
    const sig = new FakeSignaling(this, pid); const entry = { sig, peers: null as unknown as FakeLinks, gen: 0 };
    this.sessions.set(pid, entry);
    const s = new JamSession({ roomId: "r1", participantId: pid, signaling: sig, audio, now: this.clock.now, every: this.clock.every, makePeers: (cb) => (entry.peers = new FakeLinks(this, pid, cb)) });
    (entry as { s?: JamSession }).s = s; return s;
  }
  send(from: string, to: string, bytes: Uint8Array) {
    if (this.random() < this.loss) return;
    const copies = this.random() < this.dup ? 2 : 1;
    for (let i = 0; i < copies; i++) this.clock.after(() => this.sessions.get(to)?.peers.receive(from, bytes), this.delayMs + this.random() * 4);
  }
}
class FakeSignaling implements SignalingLike {
  state: SignalingLike["state"] = "closed"; open = false; sent: ClientFrame[] = [];
  onFrame: (f: ServerFrame) => void = () => {}; onState: SignalingLike["onState"] = () => {}; onClockSample: SignalingLike["onClockSample"] = () => {};
  constructor(private room: FakeRoom, private pid: string) {}
  start() { const e = this.room.sessions.get(this.pid)!; e.gen++; this.open = true; this.state = "open"; this.deliver({ type: "welcome", v: 1, participantId: this.pid, generation: e.gen, snapshot: this.room.snapshot(), serverTime: 0 }); this.room.broadcast(); this.onClockSample({ t0: this.room.clock.t, ts: this.room.clock.t + 50, t3: this.room.clock.t }); }
  stop() { this.open = false; this.state = "closed"; }
  send(f: ClientFrame) { this.sent.push(f); }
  deliver(f: ServerFrame) { this.onFrame(f); }
}
class FakeLinks implements PeerLinksLike {
  open = new Set<string>(); control: ControlMessage[] = [];
  constructor(private room: FakeRoom, private pid: string, private cb: PeerCallbacks) {}
  update(s: RoomSnapshot) { for (const p of s.participants) if (p.participantId !== this.pid && p.connected && !this.open.has(p.participantId)) { this.open.add(p.participantId); this.room.clock.after(() => this.cb.onLinkState(p.participantId, "ready"), 5); } }
  onSignal() {}
  sendEvents(pid: string, b: Uint8Array) { if (!this.open.has(pid)) return false; this.room.send(this.pid, pid, b); return true; }
  sendControl(pid: string, m: ControlMessage) { this.room.clock.after(() => this.room.sessions.get(pid)?.peers.cb.onControl(this.pid, m), 5); }
  receive(from: string, b: Uint8Array) { this.cb.onEvents(from, b); }
  isOpen(pid: string) { return this.open.has(pid); } stats() { return null; } closeAll() { this.open.clear(); }
}

function setup(n: number) {
  const clock = new Clock(); const room = new FakeRoom(clock); const audios = Array.from({ length: n }, () => new FakeAudio());
  const ids = ["pa", "pb", "pc", "pd"].slice(0, n); const ss = ids.map((id, i) => room.add(id, audios[i]));
  ss.forEach((s) => s.start()); clock.advance(100);
  return { clock, room, audios, ss, ids };
}

test("two sessions: local note monitored once, remote note scheduled once on the right engine, instruments exchanged", async () => {
  const { clock, audios, ss } = setup(2);
  await ss[0].setInstrument(0, 24); clock.advance(20);
  ss[0].router.noteOn(60, 100, clock.t); clock.advance(5); ss[0].router.noteOff(60, clock.t); clock.advance(50);
  assert.equal(audios[0].heard("pa", "noteOn").length, 1, "local monitor once");
  assert.equal(audios[0].heard("pb", "noteOn").length, 0, "never re-broadcast to own remote engine");
  const on = audios[1].heard("pa", "noteOn"); assert.equal(on.length, 1, "remote heard once despite redundancy");
  assert.ok(on[0].t !== null && on[0].t > 0); assert.equal(audios[1].heard("pa", "noteOff").length, 1);
  assert.equal(audios[1].presets.get("pa"), 24); assert.equal(ss[1].instruments.get("pa")?.program, 24);
  assert.equal(ss[1].received.get("pa"), 1);
  clock.advance(2000); assert.equal(ss[1].receivers.get("pa")!.replay.gaps, 0, "heartbeats do not look like loss");
});

test("four sessions, same channel and pitch: each source isolated per engine", () => {
  const { clock, audios, ss, ids } = setup(4);
  ss.forEach((s) => s.router.noteOn(60, 100, clock.t)); clock.advance(50);
  ss[1].router.noteOff(60, clock.t); clock.advance(50);
  const d = audios[3];
  for (const pid of ids.slice(0, 3)) assert.equal(d.heard(pid, "noteOn").length, 1, pid);
  assert.equal(d.heard("pb", "noteOff").length, 1); assert.equal(d.heard("pa", "noteOff").length, 0); assert.equal(d.heard("pc", "noteOff").length, 0);
  assert.equal(ss[3].receivers.get("pa")!.reconciler.heldCount, 1);
});

test("seeded 5% loss + duplicates: no hung notes after the stream, heartbeats keep a held note alive", () => {
  const { clock, room, audios, ss } = setup(2); room.loss = 0.05; room.dup = 0.1; room.delayMs = 25;
  for (let i = 0; i < 200; i++) { const n = 48 + (i % 24); ss[0].router.noteOn(n, 90, clock.t); clock.advance(30); ss[0].router.noteOff(n, clock.t); clock.advance(20); }
  ss[0].router.noteOn(72, 90, clock.t); clock.advance(3000);
  const r = ss[1].receivers.get("pa")!;
  assert.deepEqual(r.reconciler.heldPitches(), [72], "only the genuinely held note remains (snapshots repaired lost releases)");
  assert.ok(r.replay.duplicates > 0 && r.replay.gaps >= 0);
  assert.ok(audios[1].heard("pa", "noteOn").length >= 150);
});

test("source goes silent: its notes are released within the lease; kick tears down once", () => {
  const { clock, room, ss } = setup(2);
  ss[0].router.noteOn(60, 100, clock.t); clock.advance(50);
  assert.equal(ss[1].receivers.get("pa")!.reconciler.heldCount, 1);
  room.loss = 1; clock.advance(1200);
  assert.equal(ss[1].receivers.get("pa")!.reconciler.heldCount, 0, "released by lease (~1 s)");
  const sig = room.sessions.get("pb")!.sig; sig.deliver({ type: "kicked" }); sig.deliver({ type: "kicked" });
  assert.equal(ss[1].phase, "kicked"); assert.equal(sig.state, "closed");
});

test("peer reconnects with a new generation: its old notes are released, stale packets ignored", () => {
  const { clock, room, ss } = setup(2);
  ss[0].router.noteOn(60, 100, clock.t); clock.advance(50);
  const ea = room.sessions.get("pa")!; ea.gen++; room.broadcast(); clock.advance(10);
  const r = ss[1].receivers.get("pa")!; assert.equal(r.reconciler.heldCount, 0); assert.equal(r.generation, ea.gen);
  ss[0].router.noteOn(62, 100, clock.t); clock.advance(50); // still stamped with old generation by pa's own view
  assert.ok(r.stats.staleGeneration > 0);
});

test("panic releases everything locally and remotely", () => {
  const { clock, audios, ss } = setup(2);
  ss[0].router.noteOn(60, 100, clock.t); ss[0].router.controlChange(64, 127, clock.t); clock.advance(50);
  ss[0].panic(); clock.advance(50);
  assert.ok(audios[0].panics >= 1); assert.equal(ss[1].receivers.get("pa")!.reconciler.heldCount, 0);
  assert.ok(audios[1].posts.some((p) => p.pid === "pa" && p.e.type === "controlChange" && (p.e as { controller?: number }).controller === 64 && (p.e as { value?: number }).value === 0));
});

test("signaling client: ticket is the first frame, backoff with fresh tickets, final close codes stop retries, grace suspends", async () => {
  const clock = new Clock(); const sockets: (WsLike & { sent: string[] })[] = []; let tickets = 0;
  const c = new SignalingClient({ ticket: async () => ({ ticket: `t${++tickets}`.padEnd(20, "x"), url: "/api/jam/ws" }), openWs: () => { const w = { readyState: 1, sent: [] as string[], send(s: string) { this.sent.push(s); }, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null } as WsLike & { sent: string[] }; sockets.push(w); return w; },
    now: clock.now, setTimer: (f, ms) => clock.after(f, ms), clearTimer: () => {}, random: () => 0.5 }, 5000, 1000);
  const states: string[] = []; c.onState = (s) => states.push(s);
  c.start(); await new Promise((r) => setTimeout(r, 0));
  sockets[0].onopen!(null); assert.equal(JSON.parse(sockets[0].sent[0]).type, "auth"); assert.ok(JSON.parse(sockets[0].sent[0]).ticket.startsWith("t1"));
  sockets[0].onmessage!({ data: JSON.stringify({ type: "welcome", v: 1, participantId: "p", generation: 1, snapshot: {}, serverTime: 0 }) });
  assert.equal(c.state, "open");
  sockets[0].onclose!({ code: 1006 }); assert.equal(c.state, "reconnecting");
  clock.advance(2000); await new Promise((r) => setTimeout(r, 0)); assert.equal(tickets, 2, "fresh ticket per attempt");
  sockets[1].onclose!({ code: 1006 }); clock.advance(6000); await new Promise((r) => setTimeout(r, 0));
  sockets[sockets.length - 1].onclose!({ code: 1006 }); assert.equal(c.state, "suspended");
  const c2 = new SignalingClient({ ticket: async () => ({ ticket: "x".repeat(20), url: "/" }), openWs: () => { const w = { readyState: 1, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null } as unknown as WsLike; sockets.push(w as never); return w; }, now: clock.now, setTimer: (f, ms) => clock.after(f, ms), clearTimer: () => {}, random: () => 0.5 });
  c2.start(); await new Promise((r) => setTimeout(r, 0)); sockets[sockets.length - 1].onclose!({ code: 4000 }); assert.equal(c2.state, "closed");
});
