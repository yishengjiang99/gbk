import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROPOSAL_TTL_MS } from "../src/workstation/controller.ts";
import { setup } from "./support/compose-setup.ts";

const fixture = () => readFileSync("public/static/bizet_carmen_act-1_05_habanera_(c)yogore.mid");
function proposeOne(c: ReturnType<typeof setup>["c"]): string {
  const tr = c.project.tracks[0];
  return c.propose(
    [{ op: "addNotes", notes: [{ trackId: tr.id, channel: tr.channel, tick: 0, duration: 240, pitch: 60, velocity: 90 }] }],
    { source: "agent" },
  ).id;
}
const statusOf = (c: ReturnType<typeof setup>["c"], id: string) => c.getState().proposals.find((p) => p.id === id)?.status;
const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); } catch (e) { return (e as { code?: string }).code ?? ""; }
  throw new Error("expected the call to throw");
};

test("discardProposal only moves pending proposals to discarded", async () => {
  const { c } = setup(fixture());
  const pending = proposeOne(c);
  c.discardProposal(pending);
  assert.equal(statusOf(c, pending), "discarded");
  const rev = c.project.revision;
  c.discardProposal(pending);
  assert.equal(statusOf(c, pending), "discarded");
  assert.equal(c.project.revision, rev, "a repeat discard is a no-op");
  assert.equal(await codeOf(() => c.commitProposal(pending, { source: "user" })), "INVALID_ARGUMENT");
});

test("discard of a committed or expired proposal is a no-op", async () => {
  const { c } = setup(fixture());
  const committed = proposeOne(c);
  c.approvalHandler = async () => true;
  const before = c.project.revision;
  await c.commitProposal(committed, { source: "agent" });
  assert.equal(statusOf(c, committed), "committed");
  const after = c.project.revision;
  assert.equal(after, before + 1);
  c.discardProposal(committed);
  assert.equal(statusOf(c, committed), "committed");
  assert.equal(c.project.revision, after);

  const expiring = proposeOne(c);
  const p = c.getState().proposals.find((x) => x.id === expiring)!;
  p.createdAt = Date.now() - PROPOSAL_TTL_MS - 1_000;
  assert.deepEqual(c.expirePendingProposals(), [expiring]);
  assert.equal(statusOf(c, expiring), "expired");
  c.discardProposal(expiring);
  assert.equal(statusOf(c, expiring), "expired");
  assert.equal(await codeOf(() => c.commitProposal(expiring, { source: "user" })), "PROPOSAL_EXPIRED");
});

test("a user edit marks a pending proposal stale; discard no-ops and commit throws STALE_REVISION", async () => {
  const { c } = setup(fixture());
  const id = proposeOne(c);
  const tr = c.project.tracks[0];
  c.edit([{ op: "addNotes", notes: [{ trackId: tr.id, channel: tr.channel, tick: 480, duration: 240, pitch: 62, velocity: 90 }] }], { label: "user" });
  assert.equal(statusOf(c, id), "stale");
  const rev = c.project.revision;
  c.discardProposal(id);
  assert.equal(statusOf(c, id), "stale");
  assert.equal(c.project.revision, rev);
  assert.equal(await codeOf(() => c.commitProposal(id, { source: "user" })), "STALE_REVISION");
});
