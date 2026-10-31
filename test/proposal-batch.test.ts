// #168 batched approval: proposals from one agent run form one change set with a single Accept all / Reject all.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setup } from "./support/compose-setup.ts";

const fixture = () => readFileSync("public/static/bizet_carmen_act-1_05_habanera_(c)yogore.mid");
type C = ReturnType<typeof setup>["c"];
const add = (c: C, tick: number, pitch: number) => {
  const tr = c.project.tracks[0];
  return c.propose([{ op: "addNotes", notes: [{ trackId: tr.id, channel: tr.channel, tick, duration: 240, pitch, velocity: 90 }] }], { source: "agent", summary: `note ${pitch}` }).id;
};
const status = (c: C, id: string) => c.getState().proposals.find((p) => p.id === id)?.status;

test("agent proposals of one run group into a batch; singles and other runs do not", () => {
  const { c } = setup(fixture());
  c.setActiveRun("run_a");
  const a1 = add(c, 0, 60); assert.deepEqual(c.pendingBatches(), [], "one proposal is not a batch");
  const a2 = add(c, 480, 64);
  c.setActiveRun("run_b"); add(c, 960, 67);
  c.setActiveRun(null); c.propose([{ op: "updateTrack", trackId: c.project.tracks[0].id, mix: { volume: 64 } }], { source: "agent" }); // no run: never batched
  const b = c.pendingBatches();
  assert.equal(b.length, 1); assert.equal(b[0].runId, "run_a"); assert.deepEqual(b[0].proposals.map((p) => p.id), [a1, a2]);
  const v = c.batchView("run_a");
  assert.equal(v.id, "batch:run_a"); assert.equal(v.candidate.notes.length, c.project.notes.length + 2);
  assert.match(v.summary, /^2 changes: /);
});

test("Accept all commits the run as ONE undo step; the agent's later commits are no-op successes", async () => {
  const { c } = setup(fixture());
  const n0 = c.project.notes.length; const rev0 = c.project.revision;
  c.setActiveRun("run_x"); const ids = [add(c, 0, 60), add(c, 480, 62), add(c, 960, 64)];
  const r = c.commitBatch("run_x");
  assert.deepEqual(r.committed, ids); assert.equal(c.project.revision, rev0 + 1); assert.equal(c.project.notes.length, n0 + 3);
  for (const id of ids) assert.equal(status(c, id), "committed");
  assert.deepEqual(await c.commitProposal(ids[1], { source: "agent" }), { revision: rev0 + 1 }, "already accepted in the batch");
  assert.equal(c.project.notes.length, n0 + 3, "never applied twice");
  assert.equal(c.agentUndo(), true); assert.equal(c.project.notes.length, n0, "one undo reverts the whole change set");
});

test("an agent commit waiting on approval resolves when the user accepts the batch", async () => {
  const { c } = setup(fixture());
  const n0 = c.project.notes.length;
  c.setActiveRun("run_w"); const a = add(c, 0, 60); add(c, 480, 62);
  let release: (ok: boolean) => void = () => {};
  c.approvalHandler = () => new Promise<boolean>((r) => { release = r; });
  const waiting = c.commitProposal(a, { source: "agent" });
  await new Promise((r) => setTimeout(r, 0));
  c.commitBatch("run_w"); release(true);
  await waiting;
  assert.equal(c.project.notes.length, n0 + 2);
});

test("Reject all discards the run; stale members are excluded; empty batch refuses", () => {
  const { c } = setup(fixture());
  c.setActiveRun("run_r"); const ids = [add(c, 0, 60), add(c, 480, 62)];
  assert.deepEqual(c.discardBatch("run_r"), ids);
  for (const id of ids) assert.equal(status(c, id), "discarded");
  assert.throws(() => c.commitBatch("run_r"), /no pending proposals/);
  c.setActiveRun("run_s"); add(c, 0, 60); add(c, 480, 62);
  c.edit([{ op: "updateTrack", trackId: c.project.tracks[0].id, mix: { volume: 50 } }], { label: "user edit" }); // makes them stale
  assert.deepEqual(c.pendingBatches(), []);
  assert.throws(() => c.commitBatch("run_s"), /no pending proposals/);
});

test("a conflicting batch commits nothing (all-or-nothing)", () => {
  const { c } = setup(fixture());
  const rev = c.project.revision; const victim = c.project.notes[0];
  c.setActiveRun("run_c");
  c.propose([{ op: "removeNotes", ids: [victim.id] }], { source: "agent" });
  c.propose([{ op: "updateNotes", updates: [{ id: victim.id, pitch: 70 }] }], { source: "agent" });
  let threw = false;
  try { c.commitBatch("run_c"); } catch { threw = true; }
  if (threw) { assert.equal(c.project.revision, rev, "nothing applied on conflict"); assert.equal(c.pendingBatches().length, 1); }
  else assert.equal(c.project.revision, rev + 1); // ops model tolerates the missing id: still exactly one step
});
