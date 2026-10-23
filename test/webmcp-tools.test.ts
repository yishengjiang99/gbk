import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WorkstationController } from "../src/workstation/controller.ts";
import { parseSmf, serializeSmf } from "../src/workstation/smf.ts";
import { buildCoreTools, runTool, type ToolResult } from "../src/webmcp/tools.ts";
import { registerWebMcpTools, getModelContext, unregisterWebMcpTools } from "../src/webmcp/adapter.ts";

function setup() {
  const c = new WorkstationController(parseSmf(readFileSync("public/static/bizet_carmen_act-1_05_habanera_(c)yogore.mid"), "carmen"));
  const tools = new Map(buildCoreTools(c).map((t) => [t.name, t]));
  const call = (name: string, args: unknown = {}, signal = new AbortController().signal) => runTool(c, tools.get(name)!, args, signal);
  return { c, call, tools };
}

test("all tools have gbk_ prefix, strict object schemas, readOnly flags", () => {
  const { tools } = setup();
  for (const t of tools.values()) {
    assert.match(t.name, /^gbk_[a-z_]+$/);
    assert.equal(t.inputSchema.type, "object");
    assert.equal(t.inputSchema.additionalProperties, false);
  }
  assert.equal(tools.get("gbk_get_notes")!.readOnly, true);
  assert.equal(tools.get("gbk_commit_proposal")!.readOnly, false);
});

test("reads: summary, tracks, paginated notes, cc effective state", async () => {
  const { call } = setup();
  const s = await call("gbk_get_project_summary");
  assert.ok(s.ok); assert.ok((s.data as { noteCount: number }).noteCount > 100);
  const tr = (await call("gbk_list_tracks")).data as { id: string; notes: number }[];
  const t = tr.find((x) => x.notes > 0)!;
  const n = await call("gbk_get_notes", { trackIds: [t.id], limit: 5, range: { unit: "bars", start: 1, end: 4 } });
  assert.ok(n.ok); assert.ok(((n.data as { notes: unknown[] }).notes.length) <= 5);
  const cc = await call("gbk_get_cc_events", { trackId: t.id, range: { unit: "bars", start: 2, end: 3 } });
  assert.ok(cc.ok);
});

test("invalid args -> INVALID_ARGUMENT / INVALID_RANGE with envelope", async () => {
  const { call } = setup();
  const r = await call("gbk_get_notes", { bogus: 1 });
  assert.equal(r.ok, false); assert.equal(r.error!.code, "INVALID_ARGUMENT");
  const t = ((await call("gbk_list_tracks")).data as { id: string }[])[1].id;
  const r2 = await call("gbk_generate_cc_curve", { trackIds: [t], controller: 11, shape: "crescendo", range: { unit: "bars", start: 5, end: 2 } });
  assert.equal(r2.error!.code, "INVALID_RANGE");
});

test("CC11 crescendo proposal over bars 9-16 -> reject no mutation; accept with approval; undo/redo; export keeps CCs", async () => {
  const { c, call } = setup();
  const t = ((await call("gbk_list_tracks")).data as { id: string; notes: number }[]).find((x) => x.notes > 0)!.id;
  const rev0 = c.project.revision; const snapshot = c.project;
  const g = await call("gbk_generate_cc_curve", { trackIds: [t], controller: 11, shape: "crescendo", from: 30, to: 120, range: { unit: "bars", start: 9, end: 16 }, density: { unit: "beats", step: 0.25 }, baseRevision: rev0 });
  assert.ok(g.ok, JSON.stringify(g.error));
  const pid = (g.data as { proposalId: string }).proposalId;
  await call("gbk_discard_proposal", { proposalId: pid });
  assert.equal(c.project, snapshot);
  const g2 = await call("gbk_generate_cc_curve", { trackIds: [t], controller: 1, shape: "swell", range: { unit: "bars", start: 9, end: 16 } });
  const pid2 = (g2.data as { proposalId: string }).proposalId;
  const denied = await call("gbk_commit_proposal", { proposalId: pid2 });
  assert.equal(denied.error!.code, "USER_APPROVAL_REQUIRED");
  c.approvalHandler = async () => true;
  const ok = await call("gbk_commit_proposal", { proposalId: pid2 });
  assert.ok(ok.ok); assert.equal(ok.revision, rev0 + 1);
  const cc1 = c.project.ccs.filter((e) => e.trackId === t && e.controller === 1);
  assert.ok(cc1.length > 4);
  const back = parseSmf(serializeSmf(c.project));
  assert.equal(back.ccs.filter((e) => e.controller === 1).length, c.project.ccs.filter((e) => e.controller === 1).length);
  await call("gbk_undo"); assert.equal(c.project.ccs.filter((e) => e.trackId === t && e.controller === 1).length, 0);
  await call("gbk_redo"); assert.equal(c.project.ccs.filter((e) => e.trackId === t && e.controller === 1).length, cc1.length);
});

test("stale revision and cancellation", async () => {
  const { c, call } = setup();
  const t = c.project.tracks[1].id;
  const r = await call("gbk_set_track_mix", { trackId: t, pan: 20, baseRevision: 999 });
  assert.equal(r.error!.code, "STALE_REVISION");
  const ac = new AbortController(); ac.abort();
  const r2 = await call("gbk_get_project_summary", {}, ac.signal);
  assert.equal(r2.error!.code, "OPERATION_CANCELLED");
  const r3 = await call("gbk_set_transport", { action: "play" });
  assert.equal(r3.error!.code, "AUDIO_NOT_READY");
});

test("set_track_mix default vs override", async () => {
  const { c, call } = setup();
  const t = c.project.tracks[1].id;
  await call("gbk_set_track_mix", { trackId: t, pan: 20 });
  assert.equal(c.project.tracks[1].mix.pan, 20);
  await call("gbk_set_track_mix", { trackId: t, mode: "override", volume: 10 });
  assert.equal(c.project.tracks[1].mix.volume, 100);
  assert.equal(c.getState().overrides[t].volume, 10);
});

test("adapter: feature detection, register once, unregister via AbortSignal, execute returns JSON envelope", async () => {
  assert.equal(getModelContext({}), null);
  const registered = new Map<string, { execute: (i: unknown, c?: unknown) => Promise<unknown>; annotations: { readOnlyHint: boolean } }>();
  const mc = { registerTool(tool: never, opts: { signal: AbortSignal }) { const t = tool as { name: string }; registered.set(t.name, tool); opts.signal.addEventListener("abort", () => registered.delete(t.name)); } };
  assert.equal(getModelContext({ navigator: { modelContext: mc } }), mc);
  const { c } = setup();
  const reg1 = await registerWebMcpTools(c, buildCoreTools(c), mc as never);
  const n = registered.size;
  await registerWebMcpTools(c, buildCoreTools(c), mc as never); // re-render/HMR
  assert.equal(registered.size, n);
  assert.equal(registered.get("gbk_list_tracks")!.annotations.readOnlyHint, true);
  const out = JSON.parse(await registered.get("gbk_get_project_summary")!.execute({}, { signal: new AbortController().signal }) as string) as ToolResult;
  assert.equal(out.ok, true); assert.equal(out.projectId, c.project.id);
  reg1!.unregister(); // stale handle: no-op
  assert.equal(registered.size, n);
  unregisterWebMcpTools();
  assert.equal(registered.size, 0);
});
