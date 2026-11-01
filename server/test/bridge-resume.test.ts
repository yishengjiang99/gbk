// iOS backgrounding: a dropped browser socket pauses the run (not fails it); the same tab re-attaches within the pause
// window and in-flight / queued tool calls are replayed; past the window the run fails fast with a clear message and can
// be resumed with one tap for a while; resumes are bound to the same user + tab and rate limited.
import test from "node:test";
import assert from "node:assert/strict";
import { ScriptModel, reply, calls, tc } from "./helpers.ts";
import { startServer, login, TestTab } from "./ws-helpers.ts";
import { WorkstationController } from "../../src/workstation/controller.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (f: () => boolean, ms = 5000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await sleep(10); } };

test("drop + reconnect within the pause window: the in-flight create_project is replayed and runs exactly once", async () => {
  const model = new ScriptModel([() => calls(tc("c1", "gbk_create_project", { name: "Paused Song", tempo: 90 })), () => reply("resumed fine")]);
  const s = await startServer(model, { AGENT_RECONNECT_GRACE_MS: "5000" });
  try {
    const a = await login(s.base, "code-a"); const c = new WorkstationController();
    const tab = new TestTab(c); tab.autoRespond = false; await tab.open(s.base, a.cookie);
    tab.send({ type: "user_message", clientMessageId: "u", text: "go" });
    const st = await tab.waitFor("run_started"); const call = await tab.waitFor("tool_call"); tab.ws.terminate();
    await sleep(300);
    assert.equal(tab.events.some((e) => e.type === "run_failed"), false, "paused, not failed");
    const tab2 = new TestTab(c); tab2.resumeRunId = st.runId; await tab2.open(s.base, a.cookie);
    const replay = await tab2.waitFor("tool_call"); assert.equal(replay.callId, call.callId);
    const done = await tab2.waitFor("run_completed"); assert.equal(done.text, "resumed fine");
    assert.deepEqual(tab2.executed, ["gbk_create_project"]);
    assert.equal(c.project.name, "Paused Song");
  } finally { await s.app.close(); }
});

test("server-side dedupe: a create_project that already ran before the drop is not run twice after a page reload", async () => {
  const model = new ScriptModel([() => calls(tc("c1", "gbk_create_project", { name: "Once Only", tempo: 100 })), () => reply("ok")]);
  const s = await startServer(model, { AGENT_RECONNECT_GRACE_MS: "5000" });
  try {
    const a = await login(s.base, "code-a"); const c = new WorkstationController();
    const tab = new TestTab(c); tab.autoRespond = false; await tab.open(s.base, a.cookie);
    tab.send({ type: "user_message", clientMessageId: "u", text: "go" });
    const st = await tab.waitFor("run_started"); const call = await tab.waitFor("tool_call");
    await tab.bridge.execute(call, tab.sessionId); // ran in the page, but the result never made it (page discarded)
    tab.ws.terminate(); const created = c.project.id;
    const tab2 = new TestTab(c); tab2.resumeRunId = st.runId; await tab2.open(s.base, a.cookie);
    const done = await tab2.waitFor("run_completed"); assert.equal(done.text, "ok");
    assert.deepEqual(tab2.executed, [], "not replayed into the reloaded page");
    const tcmp = tab2.events.find((e) => e.type === "tool_completed"); assert.ok(tcmp && tcmp.type === "tool_completed" && tcmp.ok && tcmp.projectId === created);
  } finally { await s.app.close(); }
});

test("a tool call issued while the tab is away is queued (not failed) and sent on re-attach", async () => {
  let release!: () => void; const gate = new Promise<void>((ok) => { release = ok; });
  const model = new ScriptModel([async () => { await gate; return calls(tc("a", "gbk_list_tracks")); }, () => reply("done")]);
  const s = await startServer(model, { AGENT_RECONNECT_GRACE_MS: "5000" });
  try {
    const a = await login(s.base, "code-a"); const c = new WorkstationController();
    const tab = new TestTab(c); await tab.open(s.base, a.cookie);
    tab.send({ type: "user_message", clientMessageId: "u", text: "go" });
    const st = await tab.waitFor("run_started"); tab.ws.terminate(); await sleep(100);
    release(); await sleep(300); // the call is issued while no socket is attached
    const tab2 = new TestTab(c); tab2.resumeRunId = st.runId; await tab2.open(s.base, a.cookie);
    const done = await tab2.waitFor("run_completed"); assert.equal(done.text, "done");
    const tcmp = tab2.events.find((e) => e.type === "tool_completed"); assert.ok(tcmp && tcmp.type === "tool_completed" && tcmp.ok);
  } finally { await s.app.close(); }
});

test("pause window expiry: the run fails fast with a clear message, then the same tab can resume it with one tap", async () => {
  const model = new ScriptModel([() => calls(tc("a", "gbk_list_tracks")), () => reply("finished after resume")]);
  const s = await startServer(model, { AGENT_RECONNECT_GRACE_MS: "300", AGENT_RESUME_WINDOW_MS: "60000" });
  try {
    const a = await login(s.base, "code-a");
    const tab = new TestTab(); tab.autoRespond = false; await tab.open(s.base, a.cookie);
    tab.send({ type: "user_message", clientMessageId: "u", text: "write a waltz" });
    const st = await tab.waitFor("run_started"); await tab.waitFor("tool_call");
    const t0 = Date.now(); tab.ws.terminate();
    // fails right after the window, not after the tool timeout
    const other = new TestTab(); other.tabId = "other"; await sleep(700); await other.open(s.base, a.cookie);
    assert.ok(Date.now() - t0 < 3000);
    // a different tab cannot resume it
    other.send({ type: "resume_run", runId: st.runId, clientMessageId: "r0" });
    await waitUntil(() => other.events.some((e) => e.type === "error" && e.code === "RESUME_DENIED"));
    const tab2 = new TestTab(); tab2.resumeRunId = st.runId; await tab2.open(s.base, a.cookie);
    const rec = tab2.events.find((e) => e.type === "session_reconnected"); assert.ok(rec && rec.type === "session_reconnected" && !rec.resumed && rec.resumable);
    tab2.send({ type: "resume_run", runId: st.runId, clientMessageId: "r1" });
    const done = await tab2.waitFor("run_completed"); assert.equal(done.text, "finished after resume");
    const lastUser = [...model.requests.at(-1)!.messages].reverse().find((m) => m.role === "user") as { content: string };
    assert.match(String(lastUser.content), /\[resume\][\s\S]*write a waltz/);
    // single use
    tab2.events.length = 0; tab2.send({ type: "resume_run", runId: st.runId, clientMessageId: "r2" });
    await waitUntil(() => tab2.events.some((e) => e.type === "error" && e.code === "RESUME_DENIED"));
  } finally { await s.app.close(); }
});

test("mismatched hello is rejected: another tab or another user cannot take over a paused run", async () => {
  const s = await startServer(new ScriptModel([() => calls(tc("a", "gbk_list_tracks")), () => reply("x")]), { AGENT_RECONNECT_GRACE_MS: "60000" });
  try {
    const a = await login(s.base, "code-a"); const b = await login(s.base, "code-b");
    const tab = new TestTab(); tab.autoRespond = false; await tab.open(s.base, a.cookie);
    tab.send({ type: "user_message", clientMessageId: "u", text: "go" });
    const st = await tab.waitFor("run_started"); await tab.waitFor("tool_call"); tab.ws.terminate(); await sleep(100);
    const thief = new TestTab(); thief.resumeRunId = st.runId; await thief.open(s.base, b.cookie); // other user, same tabId
    await sleep(200);
    const r1 = thief.events.find((e) => e.type === "session_reconnected"); assert.ok(r1 && r1.type === "session_reconnected" && !r1.resumed && r1.code === "RESUME_DENIED");
    assert.equal(thief.events.some((e) => e.type === "tool_call"), false);
    const twin = new TestTab(); twin.tabId = "another-tab"; twin.resumeRunId = st.runId; await twin.open(s.base, a.cookie); // same user, other tab
    await sleep(200);
    const r2 = twin.events.find((e) => e.type === "session_reconnected"); assert.ok(r2 && r2.type === "session_reconnected" && !r2.resumed && r2.code === "RESUME_DENIED");
    assert.equal(twin.events.some((e) => e.type === "tool_call"), false);
  } finally { await s.app.close(); }
});

test("resume attempts are rate limited per user", async () => {
  const s = await startServer(new ScriptModel([() => reply("x")]));
  try {
    const a = await login(s.base, "code-a"); let last: TestTab | undefined;
    for (let i = 0; i < 6; i++) { const t = new TestTab(); t.resumeRunId = `run_nope${i}`; await t.open(s.base, a.cookie); await sleep(30); last = t; }
    const r = last!.events.find((e) => e.type === "session_reconnected"); assert.ok(r && r.type === "session_reconnected" && r.code === "RESUME_DENIED" && /too many/.test(r.reason ?? ""));
  } finally { await s.app.close(); }
});

test("a silent (iOS-frozen) socket is dropped after 2 missed pongs, and 'backgrounded' probes it at once", async () => {
  const s = await startServer(new ScriptModel([() => reply("x")]), { AGENT_HEARTBEAT_MS: "1000" });
  try {
    const a = await login(s.base, "code-a");
    const tab = new TestTab(); tab.autoPong = false; await tab.open(s.base, a.cookie);
    let closed = 0; tab.ws.on("close", () => { closed = Date.now(); }); const t0 = Date.now();
    await waitUntil(() => closed > 0, 6000); assert.ok(closed - t0 <= 4500, `took ${closed - t0} ms`);
  } finally { await s.app.close(); }
  const s2 = await startServer(new ScriptModel([() => reply("x")]), { AGENT_HEARTBEAT_MS: "60000" }); // heartbeat can't be what drops it
  try {
    const a = await login(s2.base, "code-a");
    const tab2 = new TestTab(); tab2.autoPong = false; await tab2.open(s2.base, a.cookie);
    let closed2 = 0; tab2.ws.on("close", () => { closed2 = Date.now(); }); const t1 = Date.now();
    tab2.send({ type: "backgrounded" }); // frozen right after: no more frames or pongs from this page
    await waitUntil(() => closed2 > 0, 9000); assert.ok(closed2 - t1 < 5500, `took ${closed2 - t1} ms`);
  } finally { await s2.app.close(); }
});

test("step log carries per-call browser timings; a slow call is logged while it runs", async () => {
  const model = new ScriptModel([() => calls(tc("a", "gbk_list_tracks")), () => reply("ok")]);
  const s = await startServer(model, { AGENT_TOOL_TIMEOUT_MS: "20000" });
  const logs: Record<string, unknown>[] = []; (s.app.log as unknown as { info: (o: unknown) => void }).info = (o) => { if (o && typeof o === "object") logs.push(o as Record<string, unknown>); };
  try {
    const a = await login(s.base, "code-a"); const tab = new TestTab(); tab.autoRespond = false; await tab.open(s.base, a.cookie);
    tab.send({ type: "user_message", clientMessageId: "u", text: "go" }); const call = await tab.waitFor("tool_call");
    await waitUntil(() => logs.some((l) => l.evt === "tool_slow"), 7000); // flagged while still running
    const slow = logs.find((l) => l.evt === "tool_slow")!; assert.equal(slow.tool, "gbk_list_tracks"); assert.ok(Number(slow.ms) >= 5000);
    const result = await tab.bridge.execute(call, tab.sessionId); tab.send({ type: "tool_result", sessionId: call.sessionId, runId: call.runId, callId: call.callId, result });
    await tab.waitFor("run_completed");
    const step = logs.find((l) => l.evt === "step")!; const ms = step.ms as number[];
    assert.equal(ms.length, 1); assert.ok(ms[0] >= 5000 && ms[0] < 15000, `ms ${ms[0]}`);
  } finally { await s.app.close(); }
});
