import test from "node:test";
import assert from "node:assert/strict";
import { ScriptModel, reply, calls, tc } from "./helpers.ts";
import { startServer, login, TestTab } from "./ws-helpers.ts";
import { BrowserToolBridge } from "../../src/agent/browser-bridge.ts";
import { WorkstationController } from "../../src/workstation/controller.ts";

test("connect + manifest sync + real tool execution through the bridge (create project, tracks, arrangement)", async () => {
  const model = new ScriptModel([
    () => calls(tc("c1", "gbk_create_project", { name: "Bridge Fugue", key: "D minor", tempo: 80 })),
    () => calls(tc("c2", "gbk_generate_arrangement", { style: "baroque", key: "D minor", bars: 8, seed: 3 })),
    () => calls(tc("c3", "gbk_list_tracks")),
    () => reply("composed"),
  ]);
  const s = await startServer(model);
  try {
    const a = await login(s.base, "code-a"); assert.equal(a.status, 200);
    const tab = new TestTab(); await tab.open(s.base, a.cookie);
    const ready = tab.events.find((e) => e.type === "session_ready")!;
    assert.equal(ready.type === "session_ready" && ready.rejectedTools.length, 0);
    assert.ok(ready.type === "session_ready" && ready.acceptedTools.includes("gbk_render_wav"));
    tab.send({ type: "user_message", clientMessageId: "u1", text: "Compose a short fugue" });
    const done = await tab.waitFor("run_completed", 20000);
    assert.equal(done.text, "composed");
    assert.deepEqual(tab.executed, ["gbk_create_project", "gbk_generate_arrangement", "gbk_list_tracks"]);
    assert.equal(tab.c.project.name, "Bridge Fugue");
    assert.ok(tab.c.project.notes.length > 50, "notes landed in the real controller");
    assert.ok(tab.c.project.tracks.length >= 3);
    const completed = tab.events.filter((e) => e.type === "tool_completed");
    assert.ok(completed.every((e) => e.type === "tool_completed" && e.ok));
    tab.close();
  } finally { await s.app.close(); }
});

test("auth rejection: no cookie, wrong origin, bad code", async () => {
  const s = await startServer(new ScriptModel([() => reply("x")]));
  try {
    await assert.rejects(new TestTab().open(s.base, ""), /401/);
    const a = await login(s.base, "code-a");
    await assert.rejects(new TestTab().open(s.base, a.cookie, "https://evil.example"), /403/);
    assert.equal((await login(s.base, "wrong")).status, 401);
    assert.equal((await login(s.base, "code-a", "https://evil.example")).status, 403);
  } finally { await s.app.close(); }
});

test("manifest: tampered or unknown client tool definitions are not accepted", async () => {
  const s = await startServer(new ScriptModel([() => calls(tc("x", "gbk_evil")), () => reply("x")]));
  try {
    const a = await login(s.base, "code-a"); const tab = new TestTab();
    const m = structuredClone(tab.bridge.manifest);
    m.tools.push({ name: "gbk_evil", description: "x", inputSchema: { type: "object" }, readOnly: false, cls: "mutate" });
    m.tools[0].inputSchema = { type: "object", properties: {}, additionalProperties: true }; // tampered schema
    await tab.open(s.base, a.cookie, undefined, m);
    const ready = tab.events.find((e) => e.type === "session_ready");
    assert.ok(ready?.type === "session_ready" && ready.rejectedTools.includes("gbk_evil") && ready.rejectedTools.includes(m.tools[0].name));
    tab.send({ type: "user_message", clientMessageId: "u", text: "hi" });
    await tab.waitFor("run_completed");
    assert.deepEqual(tab.executed, []);
  } finally { await s.app.close(); }
});

test("stale revision + execution during user edits: STALE_REVISION goes back to the model", async () => {
  const model = new ScriptModel([() => calls(tc("a", "gbk_set_track_mix", { trackId: "T", volume: 50, baseRevision: 0 })), () => reply("saw stale")]);
  const s = await startServer(model);
  try {
    const a = await login(s.base, "code-a"); const c = new WorkstationController();
    c.edit([{ op: "addTrack", name: "T", channel: 0 }]); // the user edited: revision 1
    const tab = new TestTab(c); await tab.open(s.base, a.cookie);
    tab.send({ type: "user_message", clientMessageId: "u", text: "lower T" });
    await tab.waitFor("run_completed");
    const done = tab.events.find((e) => e.type === "tool_completed");
    assert.equal(done?.type === "tool_completed" && done.error?.code, "STALE_REVISION");
  } finally { await s.app.close(); }
});

test("cancel: cancel_run stops the run and the in-flight call", async () => {
  const model = new ScriptModel([() => calls(tc("a", "gbk_list_tracks")), () => reply("never")]);
  const s = await startServer(model);
  try {
    const a = await login(s.base, "code-a"); const tab = new TestTab(); tab.autoRespond = false; await tab.open(s.base, a.cookie);
    tab.send({ type: "user_message", clientMessageId: "u", text: "go" });
    const call = await tab.waitFor("tool_call"); tab.send({ type: "cancel_run", runId: call.runId });
    const f = await tab.waitFor("run_failed"); assert.equal(f.code, "OPERATION_CANCELLED");
    assert.equal(model.requests.length, 1);
  } finally { await s.app.close(); }
});

test("duplicate tool_call messages execute once; duplicate/stray tool_result messages are ignored", async () => {
  const c = new WorkstationController(); const b = new BrowserToolBridge(c);
  let runs = 0; const orig = b.tools.get("gbk_create_track")!; b.tools.set("gbk_create_track", { ...orig, run: (a, s) => { runs++; return orig.run(a, s); } });
  const msg = { type: "tool_call" as const, sessionId: "s", runId: "r", callId: "k", tool: "gbk_create_track", arguments: { name: "A" }, expectProjectId: null, consent: { newProject: false }, deadlineMs: 5000 };
  const [r1, r2] = await Promise.all([b.execute(msg, "s"), b.execute(msg, "s")]);
  assert.equal(runs, 1); assert.deepEqual(r1, r2);
  const s = await startServer(new ScriptModel([() => calls(tc("a", "gbk_list_tracks")), () => reply("ok")]));
  try {
    const a = await login(s.base, "code-a"); const tab = new TestTab(); await tab.open(s.base, a.cookie);
    tab.send({ type: "tool_result", sessionId: tab.sessionId, runId: "nope", callId: "nope", result: { ok: true, projectId: "x", revision: 9, warnings: [] } });
    tab.send({ type: "user_message", clientMessageId: "u", text: "go" });
    await tab.waitFor("run_completed");
  } finally { await s.app.close(); }
});

test("browser-side policy: session mismatch, unlisted tools, consent, project changed", async () => {
  const c = new WorkstationController(); const b = new BrowserToolBridge(c);
  const base = { type: "tool_call" as const, sessionId: "s", runId: "r", deadlineMs: 5000, expectProjectId: null, consent: { newProject: false } };
  assert.equal((await b.execute({ ...base, callId: "1", tool: "gbk_list_tracks", arguments: {} }, "other")).error?.code, "SESSION_MISMATCH");
  assert.equal((await b.execute({ ...base, callId: "2", tool: "gbk_read_wav_bytes", arguments: { artifactId: "a" } }, "s")).error?.code, "TOOL_NOT_ALLOWED");
  assert.equal((await b.execute({ ...base, callId: "3", tool: "gbk_create_project", arguments: { name: "x" } }, "s")).error?.code, "CONSENT_REQUIRED");
  assert.equal((await b.execute({ ...base, callId: "4", tool: "gbk_list_tracks", arguments: {}, expectProjectId: "prj_other" }, "s")).error?.code, "PROJECT_CHANGED");
});

test("cross-session isolation: bob cannot answer or cancel alice's calls; newer tab replaces older", async () => {
  const model = new ScriptModel([() => calls(tc("a", "gbk_list_tracks")), () => reply("alice done")]);
  const s = await startServer(model);
  try {
    const a = await login(s.base, "code-a"), b = await login(s.base, "code-b");
    const ta = new TestTab(); ta.autoRespond = false; await ta.open(s.base, a.cookie);
    const tb = new TestTab(); await tb.open(s.base, b.cookie);
    ta.send({ type: "user_message", clientMessageId: "u", text: "go" });
    const call = await ta.waitFor("tool_call");
    tb.send({ type: "cancel_run", runId: call.runId });
    tb.send({ type: "tool_result", sessionId: call.sessionId, runId: call.runId, callId: call.callId, result: { ok: false, projectId: "x", revision: 0, warnings: [], error: { code: "EVIL", message: "x" } } });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ta.events.some((e) => e.type === "run_failed"), false);
    const result = await ta.bridge.execute(call, ta.sessionId);
    ta.send({ type: "tool_result", sessionId: call.sessionId, runId: call.runId, callId: call.callId, result });
    const done = await ta.waitFor("run_completed"); assert.equal(done.text, "alice done");
    const c1 = tb.events.length; const tb2 = new TestTab(); await tb2.open(s.base, b.cookie);
    await new Promise((r) => setTimeout(r, 100)); assert.equal(tb.ws.readyState, 3, "old tab closed"); void c1;
  } finally { await s.app.close(); }
});

test("disconnect + reconnect: run resumes on the same project; tab close without reconnect fails clearly", async () => {
  let first = true;
  const model = new ScriptModel([() => calls(tc("a", "gbk_list_tracks")), () => reply("after reconnect")]);
  const s = await startServer(model, { AGENT_RECONNECT_GRACE_MS: "3000" });
  try {
    const a = await login(s.base, "code-a"); const c = new WorkstationController();
    const tab = new TestTab(c); tab.autoRespond = false; await tab.open(s.base, a.cookie);
    tab.send({ type: "user_message", clientMessageId: "u", text: "go" });
    await tab.waitFor("tool_call"); tab.ws.terminate(); first = false;
    const tab2 = new TestTab(c); await tab2.open(s.base, a.cookie);
    const done = await tab2.waitFor("run_completed"); assert.equal(done.text, "after reconnect");
    assert.ok(tab2.events.some((e) => e.type === "session_reconnected" && e.resumed));
    void first;
  } finally { await s.app.close(); }
  const s2 = await startServer(new ScriptModel([() => calls(tc("a", "gbk_list_tracks")), () => reply("x")]), { AGENT_RECONNECT_GRACE_MS: "200" });
  try {
    const a = await login(s2.base, "code-a"); const tab = new TestTab(); tab.autoRespond = false; await tab.open(s2.base, a.cookie);
    tab.send({ type: "user_message", clientMessageId: "u", text: "go" }); await tab.waitFor("tool_call"); tab.ws.terminate();
    await new Promise((r) => setTimeout(r, 600));
    const tab2 = new TestTab(); await tab2.open(s2.base, a.cookie);
    assert.ok(tab2.events.find((e) => e.type === "session_ready"));
  } finally { await s2.app.close(); }
});

test("a new message from a live tab supersedes a run orphaned by a closed tab (no RUN_ACTIVE for the whole grace window)", async () => {
  const model = new ScriptModel([() => calls(tc("a", "gbk_list_tracks")), () => reply("new run")]);
  const s = await startServer(model, { AGENT_RECONNECT_GRACE_MS: "120000" });
  try {
    const a = await login(s.base, "code-a");
    const tab = new TestTab(); tab.autoRespond = false; await tab.open(s.base, a.cookie);
    tab.send({ type: "user_message", clientMessageId: "u1", text: "go" }); await tab.waitFor("tool_call"); tab.ws.terminate();
    await new Promise((r) => setTimeout(r, 100));
    const tab2 = new TestTab(); await tab2.open(s.base, a.cookie);
    const t0 = Date.now(); tab2.send({ type: "user_message", clientMessageId: "u2", text: "again" });
    await tab2.waitFor("run_started");
    assert.equal(tab2.events.some((e) => e.type === "error" && e.code === "RUN_ACTIVE"), false);
    assert.ok(Date.now() - t0 < 6000);
  } finally { await s.app.close(); }
});
