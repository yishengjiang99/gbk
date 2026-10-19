import test from "node:test";
import assert from "node:assert/strict";

import {
  MidiClockFollower, type AudioContextLike, type AudioNodeLike, type FollowerDeps, type PortLike, type WorkerLike,
} from "../src/midi-clock/follower.ts";
import {
  MidiInputManager, type MidiAccessLike, type MidiInputLike, type MidiMessageEventLike,
} from "../src/midi-clock/midi-input-manager.ts";
import { INPUT_DISCONNECTED, MIDI_CLOCK, MIDI_START } from "../src/midi-clock/protocol.ts";
import { SyntheticMidiSource } from "../src/midi-clock/synthetic-source.ts";

// ---- fakes ----------------------------------------------------------------------------------------------
class FakeInput implements MidiInputLike {
  state = "connected";
  listeners = new Set<(e: MidiMessageEventLike) => void>();
  constructor(public id: string, public name = id) {}
  addEventListener(_t: "midimessage", fn: (e: MidiMessageEventLike) => void) { this.listeners.add(fn); }
  removeEventListener(_t: "midimessage", fn: (e: MidiMessageEventLike) => void) { this.listeners.delete(fn); }
  send(bytes: number[], timeStamp = 1): void {
    for (const fn of [...this.listeners]) fn({ data: new Uint8Array(bytes), timeStamp });
  }
}
class FakeAccess implements MidiAccessLike {
  list: FakeInput[] = [];
  stateListeners = new Set<() => void>();
  inputs = { forEach: (cb: (i: MidiInputLike) => void) => this.list.forEach(cb) };
  addEventListener(_t: "statechange", fn: () => void) { this.stateListeners.add(fn); }
  removeEventListener(_t: "statechange", fn: () => void) { this.stateListeners.delete(fn); }
  fire(): void { for (const fn of [...this.stateListeners]) fn(); }
  totalListeners(): number { return this.stateListeners.size + this.list.reduce((n, i) => n + i.listeners.size, 0); }
}

function makeEnv() {
  const log: string[] = [];
  const intervals = new Map<number, () => void>();
  let h = 0;
  const workers: FakeWorker[] = [];
  const ctxs: FakeCtx[] = [];
  const nodes: FakeNode[] = [];
  class FakeWorker implements WorkerLike {
    sent: unknown[] = []; terminated = false; onmessage: ((e: unknown) => void) | null = null;
    postMessage(d: unknown) { this.sent.push(d); }
    terminate() { this.terminated = true; log.push("worker.terminate"); }
  }
  class FakePort implements PortLike {
    sent: unknown[] = []; closed = false; onmessage: ((e: unknown) => void) | null = null;
    postMessage(d: unknown) { this.sent.push(d); }
    close() { this.closed = true; log.push("port.close"); }
  }
  class FakeNode implements AudioNodeLike {
    port = new FakePort(); connected = false; disconnected = false;
    connect() { this.connected = true; return undefined; }
    disconnect() { this.disconnected = true; log.push("node.disconnect"); }
  }
  class FakeCtx implements AudioContextLike {
    currentTime = 0; destination = {}; state = "suspended"; closeCalls = 0; modules: string[] = [];
    async resume() { this.state = "running"; }
    async close() { this.closeCalls++; this.state = "closed"; log.push("ctx.close"); }
    getOutputTimestamp() { return { contextTime: this.currentTime, performanceTime: 1000 + this.currentTime * 1000 }; }
    audioWorklet = { addModule: async (u: string) => { this.modules.push(u); } };
  }
  let now = 1000;
  const access = new FakeAccess();
  const deps: FollowerDeps = {
    createWorker: () => { const w = new FakeWorker(); workers.push(w); return w; },
    createAudioContext: () => { const c = new FakeCtx(); ctxs.push(c); return c; },
    createClickNode: () => { const n = new FakeNode(); nodes.push(n); return n; },
    clickProcessorUrl: "click-processor.js",
    now: () => now,
    timeOrigin: () => 0,
    setInterval: (fn) => { intervals.set(++h, fn); return h; },
    clearInterval: (x) => { intervals.delete(x as number); },
    requestMidiAccess: async () => access,
  };
  return { deps, log, intervals, workers, ctxs, nodes, access, advance: (ms: number) => { now += ms; }, tickIntervals: () => intervals.forEach((fn) => fn()) };
}

// ---- tests ----------------------------------------------------------------------------------------------
test("input manager: hot-plug and re-selection keep exactly one midimessage listener", () => {
  const got: [number, number][] = [];
  const lost: string[] = [];
  const access = new FakeAccess();
  const a = new FakeInput("a"), b = new FakeInput("b");
  access.list = [a, b];
  const mgr = new MidiInputManager({ onRealtime: (s, t) => got.push([s, t]), onInputLost: (id) => lost.push(id), now: () => 0 });
  mgr.attach(access);
  assert.equal(mgr.listenerCount, 0); // nothing selected yet
  mgr.select("a");
  assert.equal(a.listeners.size, 1);
  for (let i = 0; i < 5; i++) access.fire(); // statechange storms are idempotent
  mgr.select("a");
  assert.equal(a.listeners.size, 1);
  a.send([0xf8], 10); a.send([0x90, 60, 100], 11); // note-on is not a real-time message
  assert.deepEqual(got, [[0xf8, 10]]);

  mgr.select("b"); // switching moves the listener, no loss notification
  assert.equal(a.listeners.size, 0);
  assert.equal(b.listeners.size, 1);
  assert.deepEqual(lost, []);

  b.state = "disconnected"; access.fire(); // unplug
  assert.equal(b.listeners.size, 0);
  assert.deepEqual(lost, ["b"]);
  access.fire(); access.fire();
  assert.deepEqual(lost, ["b"]); // reported once

  // replug as a brand-new port object with the same id
  const b2 = new FakeInput("b");
  access.list = [a, b2];
  access.fire();
  assert.equal(b2.listeners.size, 1);
  assert.equal(b.listeners.size, 0);
  b2.send([0xfa], 20);
  assert.deepEqual(got[got.length - 1], [0xfa, 20]);
  assert.equal(got.length, 2); // exactly one delivery per message

  mgr.dispose();
  assert.equal(access.totalListeners(), 0);
  assert.equal(mgr.listenerCount, 0);
});

test("input manager: timestamp 0 falls back to now()", () => {
  const got: number[] = [];
  const access = new FakeAccess(); const a = new FakeInput("a"); access.list = [a];
  const mgr = new MidiInputManager({ onRealtime: (_s, t) => got.push(t), onInputLost: () => undefined, now: () => 777 });
  mgr.attach(access); mgr.select("a");
  a.send([0xf8], 0);
  assert.deepEqual(got, [777]);
  mgr.dispose();
});

test("follower: dispose releases worker, port, node, context, timers and MIDI listeners (and is idempotent)", async () => {
  const env = makeEnv();
  const f = new MidiClockFollower(env.deps);
  await f.start();
  await f.start(); // idempotent: still one worker/context/node
  assert.equal(env.workers.length, 1); assert.equal(env.ctxs.length, 1); assert.equal(env.nodes.length, 1);
  assert.deepEqual(env.ctxs[0].modules, ["click-processor.js"]);
  assert.ok(env.nodes[0].connected);
  const a = new FakeInput("a"); env.access.list = [a];
  await f.connectMidi("a");
  f.syntheticSource().connect();
  assert.equal(env.intervals.size, 3); // domain sampler, flush timer, synthetic pump
  assert.equal(a.listeners.size, 1);
  assert.equal(env.access.stateListeners.size, 1);

  await f.dispose();
  assert.equal(env.workers[0].terminated, true);
  assert.deepEqual(env.workers[0].sent[env.workers[0].sent.length - 1], { type: "dispose" });
  assert.equal(env.workers[0].onmessage, null);
  assert.equal(env.nodes[0].port.closed, true);
  assert.equal(env.nodes[0].port.onmessage, null);
  assert.equal(env.nodes[0].disconnected, true);
  assert.equal(env.ctxs[0].closeCalls, 1);
  assert.equal(env.intervals.size, 0);
  assert.equal(env.access.totalListeners(), 0);
  assert.equal(f.audioContext, null);
  assert.equal(f.inputListenerCount, 0);

  const sentBefore = env.workers[0].sent.length;
  f.feed(MIDI_CLOCK, 5); // ignored after dispose
  assert.equal(env.workers[0].sent.length, sentBefore);
  await f.dispose();
  assert.equal(env.ctxs[0].closeCalls, 1);
  assert.equal(env.workers[0].sent.length, sentBefore);
  await assert.rejects(f.start());
});

test("follower: dispose racing with start() leaves nothing open", async () => {
  const env = makeEnv();
  const f = new MidiClockFollower(env.deps);
  const p = f.start();
  await f.dispose();
  await p;
  assert.equal(env.workers[0].terminated, true);
  assert.equal(env.ctxs[0].closeCalls, 1);
  assert.equal(env.nodes.length, 0); // node was never created after dispose
  assert.equal(env.intervals.size, 0);
});

test("follower: unplug + replug creates no duplicate listeners, forwards each message once, schedules from status only", async () => {
  const env = makeEnv();
  const f = new MidiClockFollower(env.deps);
  await f.start();
  const a = new FakeInput("a"); env.access.list = [a];
  await f.connectMidi("a");
  a.send([0xfa], 1100); a.send([0xf8], 1101);
  const w = env.workers[0];
  assert.deepEqual(w.sent.slice(1), [[MIDI_START, 1100], [MIDI_CLOCK, 1101]]); // [0] is init

  for (let cycle = 0; cycle < 3; cycle++) {
    a.state = "disconnected"; env.access.fire();
    assert.equal(a.listeners.size, 0);
    const back = new FakeInput("a"); env.access.list = [back];
    env.access.fire();
    assert.equal(back.listeners.size, 1);
    assert.equal(env.access.stateListeners.size, 1);
    Object.assign(a, back); // keep `a` pointing at the live port for the next cycle
    env.access.list = [a];
    a.listeners = back.listeners;
    a.state = "connected";
  }
  const codes = w.sent.map((m) => (Array.isArray(m) ? m[0] : null)).filter((c) => c === INPUT_DISCONNECTED);
  assert.equal(codes.length, 3); // one disconnect notification per unplug

  // each status message yields exactly one schedule message (no clicks without a status)
  const port = env.nodes[0].port;
  const before = port.sent.filter((m) => (m as { type: string }).type === "schedule").length;
  w.onmessage?.({ data: { type: "status", running: true, runId: 1, firstBeat: 0, anchorBeat: 0, anchorMs: 1200, beatPeriodMs: 500 } });
  const after = port.sent.filter((m) => (m as { type: string }).type === "schedule").length;
  assert.equal(after - before, 1);
  await f.dispose();
});

test("synthetic source: connect/disconnect are idempotent (no stacked timers) and emit ideal-time clocks", () => {
  let now = 0;
  const timers = new Set<number>(); let h = 0;
  const out: [number, number][] = [];
  const src = new SyntheticMidiSource({
    now: () => now, emit: (c, t) => out.push([c, t]),
    setInterval: () => { timers.add(++h); return h; }, clearInterval: (x) => { timers.delete(x as number); },
  }, 120, 1);
  src.connect(); src.connect(); src.connect();
  assert.equal(timers.size, 1);
  now = 1001; src.pump();
  const clocks = out.filter(([c]) => c === MIDI_CLOCK);
  assert.equal(clocks.length, 49); // t = 0 .. 1000 ms at 20.8333 ms
  assert.ok(Math.abs(clocks[48][1] - 48 * 60000 / (120 * 24)) < 1e-9);
  src.sendStart();
  assert.deepEqual(out[out.length - 1], [MIDI_START, 1001]);
  src.disconnect(); src.disconnect();
  assert.equal(timers.size, 0);
  now = 2000; src.pump(); // pump is only driven by the timer; a manual call after disconnect still emits only due clocks
  src.connect(); // reconnect restarts from "now": no burst of catch-up clocks
  const n = out.length;
  src.pump();
  assert.ok(out.length - n <= 1);
});
