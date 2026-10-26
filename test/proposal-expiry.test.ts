// Proposal expiry: a forgotten approval must never wedge later runs. Pending proposals die at the TTL —
// the commit then fails fast with PROPOSAL_EXPIRED instead of awaiting the panel until the tool timeout —
// and a new run supersedes everything still pending from earlier runs. Fresh approvals are unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROPOSAL_TTL_MS } from "../src/workstation/controller.ts";
import { setup } from "./support/compose-setup.ts";

const fixture = () => readFileSync("public/static/bizet_carmen_act-1_05_habanera_(c)yogore.mid");

function proposeOne(c: ReturnType<typeof setup>["c"]): string {
  const tr = c.project.tracks[0];
  const p = c.propose(
    [{ op: "addNotes", notes: [{ trackId: tr.id, channel: tr.channel, tick: 0, duration: 240, pitch: 60, velocity: 90 }] }],
    { source: "agent" },
  );
  return p.id;
}
const statusOf = (c: ReturnType<typeof setup>["c"], id: string) => c.getState().proposals.find((p) => p.id === id)?.status;
const age = (c: ReturnType<typeof setup>["c"], id: string, ms: number) => {
  const p = c.getState().proposals.find((x) => x.id === id);
  assert.ok(p, `proposal ${id} exists`);
  p.createdAt = Date.now() - ms;
};
const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); } catch (e) { return (e as { code?: string }).code ?? ""; }
  throw new Error("expected the call to throw");
};

test("a pending proposal past the TTL expires; its commit fails fast and never asks for approval", async () => {
  const { c } = setup(fixture());
  let handlerCalls = 0;
  c.approvalHandler = async () => { handlerCalls++; return true; };
  const id = proposeOne(c);
  age(c, id, PROPOSAL_TTL_MS + 1_000);
  assert.deepEqual(c.expirePendingProposals(), [id]);
  assert.equal(statusOf(c, id), "expired");
  assert.equal(await codeOf(() => c.commitProposal(id, { source: "agent" })), "PROPOSAL_EXPIRED");
  assert.equal(handlerCalls, 0, "an expired proposal never reaches the approval panel");
});

test("an unanswered approval wait ends at the TTL with PROPOSAL_EXPIRED, not a hang", async () => {
  const { c } = setup(fixture());
  c.approvalHandler = () => new Promise<boolean>(() => { /* the user never answers */ });
  const id = proposeOne(c);
  age(c, id, PROPOSAL_TTL_MS - 60); // 60 ms of TTL left when the commit starts
  const t0 = Date.now();
  assert.equal(await codeOf(() => c.commitProposal(id, { source: "agent" })), "PROPOSAL_EXPIRED");
  assert.ok(Date.now() - t0 < 5_000, "the wait ended at the TTL, not at a tool timeout");
  assert.equal(statusOf(c, id), "expired");
});

test("supersede: a new run expires every still-pending proposal from earlier runs", async () => {
  const { c } = setup(fixture());
  let handlerCalls = 0;
  c.approvalHandler = async () => { handlerCalls++; return true; };
  const a = proposeOne(c);
  const b = proposeOne(c);
  assert.deepEqual(c.supersedePendingProposals().sort(), [a, b].sort());
  assert.equal(statusOf(c, a), "expired");
  assert.equal(statusOf(c, b), "expired");
  assert.equal(await codeOf(() => c.commitProposal(a, { source: "agent" })), "PROPOSAL_EXPIRED");
  assert.equal(handlerCalls, 0);
});

test("fresh proposals are untouched and the approval flow is unchanged", async () => {
  const { c } = setup(fixture());
  const id = proposeOne(c);
  assert.deepEqual(c.expirePendingProposals(), []);
  assert.equal(statusOf(c, id), "pending");
  c.approvalHandler = async () => true;
  const before = c.project.revision;
  const r = await c.commitProposal(id, { source: "agent" });
  assert.equal(r.revision, before + 1);
  assert.equal(statusOf(c, id), "committed");
  const id2 = proposeOne(c);
  c.approvalHandler = async () => false;
  assert.equal(await codeOf(() => c.commitProposal(id2, { source: "agent" })), "USER_APPROVAL_REQUIRED");
  assert.equal(statusOf(c, id2), "pending", "a declined proposal stays pending, as before");
});

test("propose() sweeps expired pendings so the list cannot accumulate dead approvals", () => {
  const { c } = setup(fixture());
  const old = proposeOne(c);
  age(c, old, PROPOSAL_TTL_MS + 1_000);
  const fresh = proposeOne(c);
  assert.equal(statusOf(c, old), "expired");
  assert.equal(statusOf(c, fresh), "pending");
});
