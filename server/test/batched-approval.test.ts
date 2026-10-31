// #168: the agent is told that one run's proposals are reviewed as one change set, and the batch's
// no-op commit result is an ordinary ok tool result for working memory (committed, not pending).
import test from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_PROMPT } from "../src/agent/prompt.ts";
import { updateWorkingMemory } from "../src/agent/runtime.ts";
import { emptyWorkingMemory } from "../src/agent/conversation.ts";

test("prompt explains run-level change sets (Accept all / Reject all, one undo step)", () => {
  assert.match(SYSTEM_PROMPT, /one change set \(Accept all \/ Reject all, applied as one undo step\)/);
  assert.match(SYSTEM_PROMPT, /already accepted in the set commits as a no-op success/);
});

test("a commit that the user already accepted in the batch clears the pending proposal", () => {
  const wm = emptyWorkingMemory(); const tr = { created: [] as string[], committed: [] as string[], approvalRequired: 0 };
  updateWorkingMemory(wm, "gbk_edit_notes", {}, { ok: true, data: { committed: false, proposalId: "prop_1_3" } } as never, tr);
  updateWorkingMemory(wm, "gbk_edit_notes", {}, { ok: true, data: { committed: false, proposalId: "prop_2_3" } } as never, tr);
  assert.deepEqual(wm.pendingProposals, ["prop_1_3", "prop_2_3"]);
  for (const id of ["prop_1_3", "prop_2_3"]) updateWorkingMemory(wm, "gbk_commit_proposal", { proposalId: id }, { ok: true, data: { revision: 4 } } as never, tr);
  assert.deepEqual(wm.pendingProposals, []); assert.deepEqual(tr.committed, ["prop_1_3", "prop_2_3"]);
});
