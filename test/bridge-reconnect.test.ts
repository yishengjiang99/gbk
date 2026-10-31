import test from "node:test";
import assert from "node:assert/strict";
import { BridgeClient } from "../src/agent/bridge-client.ts";

class FakeWS { static all: FakeWS[] = []; readyState = 0; sent: string[] = []; onopen?: () => void; onclose?: (e: { code: number }) => void; onmessage?: (e: { data: string }) => void;
  constructor(public url: string) { FakeWS.all.push(this); }
  open() { this.readyState = 1; this.onopen?.(); } send(s: string) { this.sent.push(s); } close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); } }

test("bridge client: reconnects on visibilitychange/pageshow when the socket died or went stale", () => {
  const listeners: Record<string, (() => void)[]> = {};
  const add = (k: string, f: () => void) => { (listeners[k] ??= []).push(f); };
  const g = globalThis as Record<string, unknown>;
  g.WebSocket = FakeWS; g.location = { protocol: "https:", host: "x" };
  g.document = { visibilityState: "visible", addEventListener: add, removeEventListener: () => undefined };
  g.window = { addEventListener: add, removeEventListener: () => undefined };
  const ctrl = { project: { id: "prj_1", revision: 0 }, subscribe: () => () => undefined } as never;
  const states: string[] = [];
  const c = new BridgeClient(ctrl, () => undefined, (s) => states.push(s), { manifest: [], cancel: () => undefined } as never);
  c.connect(); FakeWS.all[0].open();
  // tab resumes with a live, recently heard-from socket: just a ping, no new socket
  listeners.visibilitychange.forEach((f) => f()); assert.equal(FakeWS.all.length, 1);
  // iOS suspended the tab and the socket is silently dead (no traffic past STALE_MS): resume replaces it at once
  const real = Date.now; Date.now = () => real() + BridgeClient.STALE_MS + 1000;
  try { listeners.pageshow.forEach((f) => f()); } finally { Date.now = real; }
  assert.equal(FakeWS.all.length, 2); assert.equal(FakeWS.all[0].readyState, 3);
  // gave up after max retries ("offline"): coming back to the tab revives it
  FakeWS.all[1].open(); c.maxReconnects = 0; FakeWS.all[1].close(1006); assert.equal(states[states.length - 1], "offline");
  listeners.visibilitychange.forEach((f) => f()); assert.equal(FakeWS.all.length, 3);
  c.close();
});

test("bridge client: sends while CONNECTING are queued and flushed FIFO ahead of hello; no socket fails", () => {
  const g = globalThis as Record<string, unknown>;
  g.WebSocket = FakeWS; g.location = { protocol: "https:", host: "x" };
  g.document = { visibilityState: "visible", addEventListener: () => undefined, removeEventListener: () => undefined };
  g.window = { addEventListener: () => undefined, removeEventListener: () => undefined };
  const ctrl = { project: { id: "prj_1", revision: 0 }, subscribe: () => () => undefined } as never;
  const c = new BridgeClient(ctrl, () => undefined, () => undefined, { manifest: [], cancel: () => undefined } as never);
  // No socket at all: the send fails and queues nothing.
  assert.equal(c.send({ type: "reset_conversation" }), false);
  c.connect();
  const ws = FakeWS.all[FakeWS.all.length - 1]!;
  assert.equal(ws.readyState, 0);
  // While CONNECTING the sends are accepted into the outbox; nothing reaches the wire yet.
  assert.equal(c.send({ type: "reset_conversation" }), true);
  assert.equal(c.send({ type: "ping", t: 1 }), true);
  assert.deepEqual(ws.sent, []);
  ws.open();
  const types = ws.sent.map((s) => (JSON.parse(s) as { type: string }).type);
  assert.deepEqual(types, ["reset_conversation", "ping", "hello"], "the queue flushes in order, ahead of hello");
  // Once open, sends go straight out.
  assert.equal(c.send({ type: "ping", t: 2 }), true);
  assert.equal((JSON.parse(ws.sent[ws.sent.length - 1]!) as { type: string }).type, "ping");
  c.close();
});
