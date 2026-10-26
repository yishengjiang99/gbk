import test from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime, closeDanglingTurns } from "../src/agent/runtime.ts";
import { ToolCatalog } from "../src/agent/tool-catalog.ts";
import { AccountLimits, BudgetError, UsageLedger, limitMessage, resetTimePT } from "../src/agent/limits.ts";
import { AccountStore } from "../src/persistence/accounts.ts";
import { newConversation } from "../src/agent/conversation.ts";
import type { ChatMessage } from "../src/agent/model-client.ts";
import { testConfig, ScriptModel, FakeLink, reply, calls, tc } from "./helpers.ts";

const catalog = new ToolCatalog();
const ALL = [...catalog.tools.keys()];
const OWNER = "g-106282557537986072000";

test("admin/owner accounts skip new-account limits and get at least the Pro budget", () => {
  const now = Date.UTC(2026, 9, 26, 1);
  const cfg = testConfig({ AGENT_DAILY_TOKEN_BUDGET: "1000", AGENT_NEW_ACCOUNT_DAILY_TOKEN_BUDGET: "100", ACCOUNT_NEW_DAYS: "7", COMPOSER_ADMIN_USERS: OWNER });
  const accts = new AccountStore(":memory:", () => now);
  accts.upsertOAuth("google", "106282557537986072000", "yisheng", null); accts.upsertOAuth("google", "999", "newbie", null);
  const lim = new AccountLimits(cfg, accts, () => now);
  assert.equal(lim.isNew(OWNER), false);
  const o = lim.for(OWNER);
  assert.equal(o.newAccount, false); assert.equal(o.pro, true); assert.equal(o.dailyTokens, 1000 * AccountLimits.PRO_TOKEN_MULTIPLIER);
  assert.equal(lim.for("g-999").dailyTokens, 100);
  const ledger = new UsageLedger(cfg, () => now, accts, lim);
  ledger.record(OWNER, { promptTokens: 1500, completionTokens: 600 }); // past the new-account (100) and standard (1000) caps
  assert.doesNotThrow(() => ledger.check(OWNER));
});

test("budget: start-of-run check is strict; in-flight steps may overrun by 25%; message is plain with reset time and Pro pointer", () => {
  const now = Date.UTC(2026, 9, 26, 1);
  const cfg = testConfig({ AGENT_DAILY_TOKEN_BUDGET: "100" });
  const ledger = new UsageLedger(cfg, () => now);
  ledger.record("bob", { promptTokens: 100, completionTokens: 10 });
  assert.throws(() => ledger.check("bob"), (e) => e instanceof BudgetError && e.message === "You've hit today's AI limit. It resets at 5 PM PT. Go Pro for a 10× daily AI budget.");
  assert.doesNotThrow(() => ledger.check("bob", { inFlight: true }));
  ledger.record("bob", { promptTokens: 20, completionTokens: 0 });
  assert.throws(() => ledger.check("bob", { inFlight: true }));
  assert.equal(resetTimePT(Date.UTC(2026, 11, 1, 12)), "4 PM PT"); // PST in winter
  assert.equal(limitMessage(true, now), "You've hit today's AI limit. It resets at 5 PM PT.");
});

function setup(script: ConstructorParameters<typeof ScriptModel>[0], over: Record<string, string> = {}) {
  const cfg = testConfig(over); const model = new ScriptModel(script); const ledger = new UsageLedger(cfg);
  const rt = new AgentRuntime(cfg, model, catalog, ledger); const conv = newConversation("alice"); const link = new FakeLink(ALL);
  const go = (text: string) => rt.run({ runId: "run_1", user: "alice", text, model: "fake-model", conv, link, signal: new AbortController().signal });
  return { model, ledger, conv, go };
}

test("a run that starts under budget finishes instead of stopping mid-composition", async () => {
  // 110 tokens per step, limit 200: the strict check would stop before step 3 (220 >= 200); overrun allows up to 250.
  const s = setup([() => calls(tc("a", "gbk_list_tracks")), () => calls(tc("b", "gbk_list_tracks")), () => reply("done")], { AGENT_DAILY_TOKEN_BUDGET: "200" });
  const r = await s.go("compose");
  assert.equal(r.status, "completed");
});

test("budget failure happens before the prompt is stored; failed prompts are closed so later runs never answer them", async () => {
  const s = setup([() => reply("jazz reply")], { AGENT_DAILY_TOKEN_BUDGET: "100" });
  s.ledger.record("alice", { promptTokens: 100, completionTokens: 0 });
  const r = await s.go("Adagio please");
  assert.equal(r.code, "TOKEN_BUDGET_EXHAUSTED");
  assert.equal(s.conv.messages.filter((m) => m.role === "user").length, 0);
  assert.equal(s.model.requests.length, 0);

  // A mid-run failure (overrun exhausted) appends an assistant message closing the turn.
  const s2 = setup([() => calls(tc("a", "gbk_list_tracks")), () => calls(tc("b", "gbk_list_tracks")), () => reply("x")], { AGENT_DAILY_TOKEN_BUDGET: "100" });
  const r2 = await s2.go("Adagio please");
  assert.equal(r2.code, "TOKEN_BUDGET_EXHAUSTED");
  const last = s2.conv.messages.at(-1)!;
  assert.equal(last.role, "assistant"); assert.match(String(last.content), /TOKEN_BUDGET_EXHAUSTED/);
});

test("closeDanglingTurns closes legacy unanswered prompts (stored conversations) without touching answered ones", async () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: "Adagio" }, { role: "user", content: "Jazz" },
    { role: "assistant", content: "ok" }, { role: "user", content: "More bass" },
  ];
  closeDanglingTurns(msgs);
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "user", "assistant", "user", "assistant"]);
  closeDanglingTurns(msgs);
  assert.equal(msgs.length, 6);

  // Through the runtime: the model only sees the newest prompt as the open request.
  const s = setup([() => reply("jazz!")]);
  s.conv.messages.push({ role: "user", content: "Adagio" });
  await s.go("Jazz");
  const sent = s.model.requests[0].messages.filter((m) => m.role !== "system");
  assert.deepEqual(sent.map((m) => m.role), ["user", "assistant", "user"]);
  assert.match(String(sent[2].content), /^Jazz/);
});
