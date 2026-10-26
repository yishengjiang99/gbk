import test from "node:test";
import assert from "node:assert/strict";
import { PublishPromptGate, buildPricingHref, isBudgetError, isHardReason, readAttribution, resetLabel } from "../src/agent/paywall.ts";

test("pricing href carries the plan and the stored attribution ids (#116/#131)", () => {
  const href = buildPricingHref("pro_yearly", { utm_source: "reddit", utm_campaign: "launch", twclid: "abc123" });
  const u = new URL(href, "https://compose.test");
  assert.equal(u.pathname, "/pricing");
  assert.equal(u.searchParams.get("plan"), "pro_yearly");
  assert.equal(u.searchParams.get("utm_source"), "reddit");
  assert.equal(u.searchParams.get("utm_campaign"), "launch");
  assert.equal(u.searchParams.get("twclid"), "abc123");
  assert.equal(u.searchParams.get("rdt_cid"), null, "unstored ids are not invented");
  assert.equal(buildPricingHref("lifetime", {}), "/pricing?plan=lifetime");
});

test("readAttribution: gbk_* cookies win, sessionStorage mirrors, junk is dropped", () => {
  const session = (k: string) => (k === "gbk_rdt_cid" ? "sess-rdt" : k === "gbk_utm_medium" ? "sess-med" : null);
  const out = readAttribution("gbk_utm_source=google%20ads; other=1; gbk_twclid=tw-1; gbk_utm_medium=", session);
  assert.equal(out.utm_source, "google ads", "cookie value is decoded");
  assert.equal(out.twclid, "tw-1");
  assert.equal(out.rdt_cid, "sess-rdt", "falls back to the session mirror");
  assert.equal(out.utm_medium, "sess-med", "empty cookie falls back to the session mirror");
  assert.equal(out.utm_campaign, undefined);
  assert.deepEqual(readAttribution("", () => null), {});
});

test("hard reasons and budget error codes drive the hard modal", () => {
  assert.equal(isHardReason("ai_limit"), true);
  assert.equal(isHardReason("render_limit"), true);
  assert.equal(isHardReason("second_composition"), false);
  assert.equal(isHardReason("export_after_2"), false);
  assert.equal(isHardReason(null), false);
  for (const c of ["TOKEN_BUDGET_EXHAUSTED", "COST_BUDGET_EXHAUSTED", "GLOBAL_BUDGET_EXHAUSTED"]) assert.equal(isBudgetError(c), true, c);
  for (const c of ["RATE_LIMITED", "TOOL_TIMEOUT", "", null, undefined]) assert.equal(isBudgetError(c), false, String(c));
});

test("resetLabel names the next UTC midnight in Pacific time, like the server", () => {
  // 2026-10-26 12:00 UTC -> next reset is 2026-10-27 00:00 UTC = 5 PM PDT.
  assert.equal(resetLabel(Date.UTC(2026, 9, 26, 12, 0, 0)), "5 PM PT");
  // Winter: 00:00 UTC = 4 PM PST.
  assert.equal(resetLabel(Date.UTC(2026, 0, 15, 12, 0, 0)), "4 PM PT");
});

test("PublishPromptGate: with no paywall activity the publish offer fires immediately", () => {
  const g = new PublishPromptGate();
  let fired = 0;
  g.offerPublish(() => { fired++; });
  assert.equal(fired, 1);
});

test("PublishPromptGate: an offer made while the paywall decides is released when no paywall shows", () => {
  const g = new PublishPromptGate();
  let fired = 0;
  g.beginDecision();
  g.offerPublish(() => { fired++; });
  assert.equal(fired, 0, "held while the decision is in flight");
  g.endDecision();
  assert.equal(fired, 1, "released once the decision ends with no paywall");
});

test("PublishPromptGate: the paywall wins — a held offer fires only after the paywall closes", () => {
  const g = new PublishPromptGate();
  let fired = 0;
  g.beginDecision();
  g.offerPublish(() => { fired++; });
  g.notePaywallShown();
  g.endDecision();
  assert.equal(fired, 0, "still held while the paywall is visible");
  g.notePaywallClosed();
  assert.equal(fired, 1, "released on paywall close");
});

test("PublishPromptGate: an offer made while the paywall is visible waits for the close; latest offer wins", () => {
  const g = new PublishPromptGate();
  const fired: string[] = [];
  g.notePaywallShown();
  g.offerPublish(() => fired.push("first"));
  g.offerPublish(() => fired.push("second"));
  assert.deepEqual(fired, []);
  g.notePaywallClosed();
  assert.deepEqual(fired, ["second"], "only the newest held offer is released");
});
