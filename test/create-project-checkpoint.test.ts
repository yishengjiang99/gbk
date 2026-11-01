// Remix -> "Creating project" regression: gbk_create_project must not wait on a stalled checkpoint (iOS IndexedDB).
import test from "node:test";
import assert from "node:assert/strict";
import { WorkstationController, CHECKPOINT_BUDGET_MS } from "../src/workstation/controller.ts";
import { emptyProject } from "../src/workstation/model.ts";

const seeded = () => { const c = new WorkstationController(emptyProject("Fork", 480));
  c.edit([{ op: "addTrack", name: "Lead", channel: 0, id: "t_l", program: 0 }, { op: "addNotes", notes: [{ trackId: "t_l", channel: 0, tick: 0, duration: 480, pitch: 60, velocity: 90 }] }], { label: "seed" }); return c; };

test("create_project over a project with content: a fast checkpoint is awaited", async () => {
  const c = seeded(); let saved = ""; c.host.checkpoint = async (p) => { saved = p.id; };
  const prev = c.project.id; const r = await c.createProject({ name: "New", owner: "agent" });
  assert.equal(r.checkpointed, true); assert.equal(saved, prev);
});

test("create_project never waits longer than the checkpoint budget for a stalled checkpoint", async () => {
  const c = seeded(); let slow = 0; c.host.checkpoint = () => new Promise(() => {}); c.host.onSlowCheckpoint = () => { slow++; };
  const t0 = Date.now(); const r = await c.createProject({ name: "New", owner: "agent" }); const ms = Date.now() - t0;
  assert.equal(r.checkpointed, false); assert.equal(c.project.name, "New"); assert.equal(slow, 1);
  assert.ok(ms >= CHECKPOINT_BUDGET_MS - 50 && ms < CHECKPOINT_BUDGET_MS + 500, `took ${ms} ms`);
  assert.ok(CHECKPOINT_BUDGET_MS <= 2000, "budget stays small");
});

test("a checkpoint that fails still fails create_project (no silent data loss)", async () => {
  const c = seeded(); c.host.checkpoint = async () => { throw new Error("quota"); };
  await assert.rejects(c.createProject({ name: "New", owner: "agent" }), /quota/);
});
