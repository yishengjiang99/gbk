import test from "node:test";
import assert from "node:assert/strict";
import { PAYWALL_PLANS, PublishPromptGate, buildPricingHref, classifyExportCheck, isBudgetError, isHardReason, readAttribution, resetLabel, shouldShowThirdSong } from "../src/agent/paywall.ts";

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
  assert.equal(isHardReason("export"), true);
  assert.equal(isHardReason("ai_budget"), true);
  assert.equal(isHardReason("render_limit"), true);
  assert.equal(isHardReason("third_song"), false, "the 3rd-song popup is soft (dismissible)");
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

test("pricing href carries the paywall reason for the iOS intercept and the funnel", () => {
  const u = new URL(buildPricingHref("pro_yearly", { utm_source: "x" }, "export"), "https://compose.test");
  assert.equal(u.searchParams.get("reason"), "export"); assert.equal(u.searchParams.get("plan"), "pro_yearly"); assert.equal(u.searchParams.get("utm_source"), "x");
  assert.equal(buildPricingHref("pro_yearly", {}, null), "/pricing?plan=pro_yearly");
});

test("export gate: 402 blocks, a JSON 2xx allows, no Composer server (non-JSON) allows, other JSON errors fail closed", () => {
  assert.equal(classifyExportCheck(402, "application/json; charset=utf-8"), "blocked");
  assert.equal(classifyExportCheck(200, "application/json"), "allowed");
  assert.equal(classifyExportCheck(404, "text/html"), "allowed", "static GitHub Pages build: nothing is sold there");
  assert.equal(classifyExportCheck(404, null), "allowed");
  assert.equal(classifyExportCheck(500, "application/json"), "error");
  assert.equal(classifyExportCheck(429, "application/json"), "error");
});

test("3rd-song popup: free users with 2+ songs starting another, once", () => {
  assert.equal(shouldShowThirdSong({ pro: false, seen: false, existingSongs: 2 }), true, "starting the 3rd");
  assert.equal(shouldShowThirdSong({ pro: false, seen: false, existingSongs: 5 }), true);
  assert.equal(shouldShowThirdSong({ pro: false, seen: false, existingSongs: 1 }), false, "the first two songs stay fully free");
  assert.equal(shouldShowThirdSong({ pro: false, seen: true, existingSongs: 3 }), false, "shown once");
  assert.equal(shouldShowThirdSong({ pro: true, seen: false, existingSongs: 3 }), false, "never for Pro");
});

test("paywall leads with the yearly plan and the 7-day trial; prices unchanged", () => {
  assert.equal(PAYWALL_PLANS[0].id, "pro_yearly"); assert.equal(PAYWALL_PLANS[0].trial, true); assert.match(PAYWALL_PLANS[0].note, /7-day free trial/);
  assert.deepEqual(PAYWALL_PLANS.map((p) => p.price), ["$47.99", "$5.99", "$99.99"]);
});
