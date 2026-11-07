import test from "node:test";
import assert from "node:assert/strict";
import { RunLink, TAB_GONE, PAUSED_TOO_LONG, type Conn } from "../src/bridge/run-link.ts";
import type { ServerMessage } from "../src/bridge/protocol.ts";

function mockConn(sessionId = "s1"): Conn & { sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  return { sessionId, allowedTools: new Set(["gbk_foo"]), projectId: "p1", revision: 0, alive: true, emit(m) { sent.push(m); }, sent };
}

test("RunLink: detach pauses; grace expiry ends the run as expired", async () => {
  const c = mockConn();
  const link = new RunLink("run1", c, 30, () => null, "tab1");
  assert.equal(link.state, "running");
  link.detach(c);
  assert.equal(link.state, "paused");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(link.state, "ended");
  assert.equal(link.endReason, "expired");
});

test("RunLink: rebind before grace resumes and replays outstanding calls", async () => {
  const c1 = mockConn("s1");
  const link = new RunLink("run1", c1, 5_000, () => null, "tab1");
  const pending = link.callTool("run1", "call-1", "gbk_foo", { x: 1 }, { expectProjectId: null, consent: { newProject: false }, timeoutMs: 5_000 });
  assert.equal(c1.sent.some((m) => m.type === "tool_call"), true);
  link.detach(c1);
  assert.equal(link.state, "paused");
  const c2 = mockConn("s2");
  assert.equal(link.rebind(c2), true);
  assert.equal(link.state, "running");
  assert.equal(c2.sent[0]?.type, "session_reconnected");
  assert.equal((c2.sent[0] as { resumed?: boolean }).resumed, true);
  assert.equal(c2.sent.some((m) => m.type === "tool_call"), true);
  assert.equal(link.settle("call-1", c2, { ok: true, projectId: "p1", revision: 0, data: {}, warnings: [] }), true);
  assert.equal((await pending).ok, true);
});

test("RunLink: a fresh page ends the link as replaced; later rebind is refused", async () => {
  const c = mockConn();
  const link = new RunLink("run1", c, 5_000, () => null, "tab1");
  const pending = link.callTool("run1", "call-2", "gbk_foo", {}, { expectProjectId: null, consent: { newProject: false }, timeoutMs: 5_000 });
  link.end("replaced");
  assert.equal(link.state, "ended");
  assert.equal(link.endReason, "replaced");
  await assert.rejects(pending, (e: Error) => e.message === TAB_GONE);
  assert.equal(link.rebind(mockConn("s3")), false);
});

test("RunLink: grace expiry rejects outstanding calls with the pause message", async () => {
  const c = mockConn();
  const link = new RunLink("run1", c, 20, () => null, "tab1");
  const pending = link.callTool("run1", "call-3", "gbk_foo", {}, { expectProjectId: null, consent: { newProject: false }, timeoutMs: 5_000 });
  link.detach(c);
  await Promise.all([
    assert.rejects(pending, (e: Error) => e.message === PAUSED_TOO_LONG),
    new Promise((res) => setTimeout(res, 40)),
  ]);
  assert.equal(link.endReason, "expired");
});
