import test from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { ToolCatalog } from "../src/agent/tool-catalog.ts";
import { UsageLedger } from "../src/agent/limits.ts";
import { newConversation } from "../src/agent/conversation.ts";
import type { ModelClient } from "../src/agent/model-client.ts";
import { testConfig, FakeLink } from "./helpers.ts";
import { SCENARIOS, policyFor, type Scenario } from "./agent-evals/scenarios.ts";

// #163 #10: trace-assertion evals over the scripted model policy (see agent-evals/scenarios.ts).
// Real-model evals are env-gated (AGENT_EVAL_REAL=1) and intentionally not part of this file's CI run.

const catalog = new ToolCatalog();
const ALL = [...catalog.tools.keys()];

function runScenario(s: Scenario) {
  const cfg = testConfig();
  // One policy instance per scenario, shared across turns (its per-turn state comes from tool results).
  const policy = policyFor(s);
  const model: ModelClient & { requests: unknown[] } = { name: "policy", requests: [], async complete(r) { this.requests.push(r); return policy(r, this.requests.length); } };
  const rt = new AgentRuntime(cfg, model, catalog, new UsageLedger(cfg));
  const conv = newConversation("eval");
  let rev = 0;
  const link = new FakeLink(ALL, (tool): import("../src/bridge/protocol.ts").ToolResultEnvelope => {
    rev++;
    if (tool === "gbk_create_project") return { ok: true, projectId: "prj_1", revision: rev, data: { projectId: "prj_1" }, warnings: [] };
    if (tool === "gbk_transform_notes") return { ok: true, projectId: "prj_1", revision: rev, data: { key: "A major" }, warnings: [] };
    if (tool === "gbk_get_project_summary") return { ok: true, projectId: "prj_1", revision: rev, data: { key: { name: "C minor" }, sections: [], tracks: [], tempos: [] }, warnings: [] };
    return { ok: true, projectId: "prj_1", revision: rev, data: {}, warnings: [] };
  });
  return { rt, conv, link };
}

for (const s of SCENARIOS) {
  test(`eval: ${s.name}`, async () => {
    const { rt, conv, link } = runScenario(s);
    if (s.prebound) conv.projectId = link.projectId;
    for (const [i, text] of s.turns.entries()) {
      const r = await rt.run({ runId: `eval_${i}`, user: "eval", text, model: "fake-model", conv, link, signal: new AbortController().signal });
      assert.equal(r.status, "completed", `turn ${i} (${text}) failed: ${r.text}`);
      assert.ok(r.steps <= s.maxStepsPerTurn, `turn ${i} used ${r.steps} steps (max ${s.maxStepsPerTurn})`);
    }
    const executed = link.executed.map((e) => e.tool);
    for (const f of s.forbiddenExecuted) assert.ok(!executed.includes(f), `${f} must never execute in this scenario`);
    for (const req of s.requiredExecuted) assert.ok(executed.includes(req), `${req} should have been executed (got: ${executed.join(", ")})`);
    if (s.expectKey) assert.equal(conv.workingMemory?.key, s.expectKey);
  });
}

test("eval harness: real-model runs stay env-gated", { skip: process.env.AGENT_EVAL_REAL !== "1" }, () => {
  assert.fail("AGENT_EVAL_REAL=1 requires a configured real model; run server/test/agent-evals via the nightly job, not PR CI");
});
