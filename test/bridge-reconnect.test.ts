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
