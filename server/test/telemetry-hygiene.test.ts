// Telemetry audit (Nov 2026): crawlers and X-GBK-Test traffic stay out of analytics, MCP connects record their
// client, expected notices / scan reports are stored as info rather than client errors.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { FunnelStore } from "../src/persistence/funnel.ts";
import { ClientErrorStore } from "../src/persistence/client-errors.ts";
import { clientErrorLevel } from "../src/routes/client-errors.ts";
import { isBotUserAgent, classifyTraffic, withTraffic, analyticsExcluded, TEST_TRAFFIC_HEADER } from "../src/security/traffic.ts";
import { testConfig, ScriptModel, reply, calls, tc } from "./helpers.ts";
import { login, startServer, TestTab } from "./ws-helpers.ts";
import { McpClient } from "./mcp-helpers.ts";

const BOTS = [
  "meta-webindexer/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36",
  "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
  "Twitterbot/1.0", "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)", "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)",
];
const HUMANS = [
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; CUBOT KINGKONG 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0] [Pinterest/iOS]",
  "GBKComposer/38 CFNetwork/1568.100.1 Darwin/24.0.0", "python-requests/2.32.3", "Cursor/1.0.0", "",
];

test("traffic: bot UA list, X-GBK-Test header, webhooks never dropped by UA, ALS scope", () => {
  for (const ua of BOTS) assert.equal(isBotUserAgent(ua), true, ua);
  for (const ua of HUMANS) assert.equal(isBotUserAgent(ua), false, ua);
  assert.equal(TEST_TRAFFIC_HEADER, "x-gbk-test");
  assert.deepEqual(classifyTraffic({ "x-gbk-test": "1" }), { bot: false, test: true });
  assert.deepEqual(classifyTraffic({ "x-gbk-test": "0" }), { bot: false, test: false });
  assert.equal(classifyTraffic({ cookie: "gbk_test=1" }).test, true);
  assert.equal(classifyTraffic({ cookie: "gbk_sid=x; gbk_test=1; z=2" }).test, true);
  assert.equal(classifyTraffic({ cookie: "gbk_test=0" }).test, false);
  assert.equal(classifyTraffic({ cookie: "xgbk_test=1; gbk_testing=1" }).test, false);
  assert.equal(classifyTraffic({ "user-agent": "Stripe/1.0 (+https://stripe.com/docs/webhooks)" }, "/api/billing/stripe-events").bot, false);
  assert.equal(classifyTraffic({ "user-agent": "Stripe/1.0 (+https://stripe.com/docs/webhooks)" }, "/api/events").bot, true);
  assert.equal(analyticsExcluded(), false);
  assert.equal(withTraffic({ bot: false, test: true }, () => analyticsExcluded()), true);
  const f = new FunnelStore(":memory:");
  withTraffic({ bot: true, test: false }, () => f.bump("page_view_landing"));
  f.bump("page_view_landing");
  assert.equal(f.summary(1).totals.page_view_landing, 1);
  f.close();
});

test("client errors: read-only/Fork notice and scan_* reports are info; migration backfills old rows", () => {
  assert.equal(clientErrorLevel("scan_completed", { event: "scan_completed" }), "info");
  assert.equal(clientErrorLevel("Error: whatever", { event: "scan_failed" }), "info");
  assert.equal(clientErrorLevel("This shared song is read-only. Press Fork to make your own editable copy.", {}), "info");
  assert.equal(clientErrorLevel("Error: Fork this song before sharing it as your own", {}), "info");
  assert.equal(clientErrorLevel("TypeError: undefined is not a function", {}), "error");
  assert.equal(clientErrorLevel("scan worker crashed", {}), "error");
  // A v1 database (before the level column) is migrated in place and backfilled.
  const file = join(mkdtempSync(join(tmpdir(), "ce-mig-")), "a.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE client_errors_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); INSERT INTO client_errors_migrations VALUES (1, 0);
    CREATE TABLE client_errors (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, client_ts INTEGER, user_id TEXT, kind TEXT NOT NULL, message TEXT NOT NULL, stack TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '', release TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 1, context TEXT NOT NULL DEFAULT '{}', breadcrumbs TEXT NOT NULL DEFAULT '[]');
    INSERT INTO client_errors (created_at, kind, message) VALUES (1, 'report', 'scan_started'), (2, 'console', 'This shared song is read-only. Tap Fork to change your own copy.'), (3, 'error', 'TypeError: boom'), (4, 'report', 'scanner failed');`);
  db.close();
  const store = new ClientErrorStore(file);
  assert.deepEqual(store.list({ limit: 10 }).map((r) => [r.message.slice(0, 12), r.level]).reverse(), [["scan_started", "info"], ["This shared ", "info"], ["TypeError: b", "error"], ["scanner fail", "error"]]);
  store.close();
});

async function serve() {
  const cfg = testConfig({ COMPOSER_PUBLIC_ORIGIN: "http://composer.test", COMPOSER_ADMIN_USERS: "alice" });
  const b = await buildApp(cfg, { model: new ScriptModel([() => reply("x")]), persist: false, logger: false });
  b.app.addHook("preClose", (done) => { b.app.server.closeAllConnections?.(); done(); });
  await b.app.listen({ port: 0, host: "127.0.0.1" });
  return { b, base: `http://127.0.0.1:${(b.app.server.address() as { port: number }).port}` };
}

test("routes: /api/events drops crawlers and X-GBK-Test, test signups/page views uncounted, MCP client recorded, client-error levels", { timeout: 60_000 }, async () => {
  const { b, base } = await serve();
  const J = { "content-type": "application/json", origin: "http://composer.test" };
  try {
    const alice = await login(base, "code-a");
    const admin = async (path: string) => (await fetch(`${base}${path}`, { headers: { cookie: alice.cookie } })).json();
    const rows = () => Number((b.shares.database.prepare("SELECT COUNT(*) AS n FROM impressions").get() as { n: number }).n);
    const body = JSON.stringify({ session: "sess-bot-0001", events: [{ song: "whatever", dwell_ms: 100 }] });
    // crawler: acknowledged, nothing stored, no gid cookie
    let r = await fetch(`${base}/api/events`, { method: "POST", headers: { ...J, "user-agent": BOTS[0] }, body });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, accepted: 0, ignored: "bot" }); assert.equal(r.headers.get("set-cookie"), null);
    // CI / UI test traffic
    r = await fetch(`${base}/api/events`, { method: "POST", headers: { ...J, "x-gbk-test": "1" }, body });
    assert.deepEqual(await r.json(), { ok: true, accepted: 0, ignored: "test" }); assert.equal(r.headers.get("set-cookie"), null);
    // same via the iOS UI-test web view cookie (sendBeacon carries cookies, not custom headers)
    r = await fetch(`${base}/api/events`, { method: "POST", headers: { ...J, cookie: "a=b; gbk_test=1" }, body });
    assert.deepEqual(await r.json(), { ok: true, accepted: 0, ignored: "test" });
    // a normal browser still gets a gid cookie (unknown song is just dropped)
    r = await fetch(`${base}/api/events`, { method: "POST", headers: { ...J, "user-agent": HUMANS[0] }, body });
    assert.equal((await r.json()).accepted, 0); assert.match(r.headers.get("set-cookie") ?? "", /gbk_gid=/);
    assert.equal(rows(), 0);
    // signups: the iOS UI tests' guest accounts (X-GBK-Test) do not count; a real one does
    const before = (await admin("/api/admin/billing?days=7")).totals.signup as number;
    await fetch(`${base}/api/auth/anonymous`, { method: "POST", headers: { "content-type": "application/json", "x-gbk-test": "1" }, body: JSON.stringify({ deviceId: "ui-test-device-0001", username: "UiTestBird" }) });
    await fetch(`${base}/api/auth/anonymous`, { method: "POST", headers: { "content-type": "application/json", cookie: "gbk_test=1" }, body: JSON.stringify({ deviceId: "ui-test-device-0002", username: "UiTestWren" }) });
    assert.equal((await admin("/api/admin/billing?days=7")).totals.signup, before);
    await fetch(`${base}/api/auth/anonymous`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId: "real-device-00000001", username: "RealBird" }) });
    assert.equal((await admin("/api/admin/billing?days=7")).totals.signup, before + 1);
    // page views: crawler fetches of the landing page do not count
    const pv = async () => (await admin("/api/admin/funnel?days=1")).totals.page_view_chatgpt as number;
    const pv0 = await pv();
    await fetch(`${base}/chatgpt`, { headers: { "user-agent": BOTS[1] } });
    await fetch(`${base}/chatgpt`, { headers: { cookie: "gbk_test=1" } }); // iOS UI-test web view page load
    assert.equal(await pv(), pv0);
    await fetch(`${base}/chatgpt`, { headers: { "user-agent": HUMANS[0], cookie: "gbk_testing=1; other=gbk_test=1" } });
    assert.equal(await pv(), pv0 + 1);
    // MCP connect records the client (clientInfo + user agent) so our own agents can be filtered out
    const mcp = new McpClient(base, { "user-agent": "python-requests/2.32.3" });
    await mcp.send("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "GBK reviewer-login live check", version: "1" } });
    const f = await admin("/api/admin/funnel?days=1");
    assert.equal(f.totals.mcp_connect, 1);
    assert.deepEqual(f.mcpClients, [{ client: "GBK reviewer-login live check/1", user_agent: "python-requests/2.32.3", oauth_client: "", source: "guest", count: 1 }]);
    // client errors: scan telemetry + read-only notice stored as info
    r = await fetch(`${base}/api/client-errors`, { method: "POST", headers: J, body: JSON.stringify({ errors: [
      { kind: "report", message: "scan_completed", context: { event: "scan_completed", totalMs: 900 } },
      { kind: "console", message: "This shared song is read-only. Press Fork to change your own copy." },
      { kind: "error", message: "TypeError: real bug" },
    ] }) });
    assert.equal(r.status, 202);
    const info = await admin("/api/admin/client-errors?level=info"), err = await admin("/api/admin/client-errors?level=error");
    assert.equal(info.errors.length, 2); assert.deepEqual(err.errors.map((e: { message: string }) => e.message), ["TypeError: real bug"]);
    assert.ok(info.errors.every((e: { level: string }) => e.level === "info"));
  } finally { await b.app.close(); }
});

test("WebSocket: a studio socket opened with gbk_test=1 does not count compositions; a normal one does", { timeout: 60_000 }, async () => {
  const model = new ScriptModel([() => calls(tc("c1", "gbk_create_project", { name: "UI Test Song" })), () => reply("ok"), () => calls(tc("c2", "gbk_create_project", { name: "Real Song" })), () => reply("ok")]);
  const s = await startServer(model, { COMPOSER_ADMIN_USERS: "alice" });
  try {
    const a = await login(s.base, "code-a");
    const totals = async () => (await (await fetch(`${s.base}/api/admin/billing?days=7`, { headers: { cookie: a.cookie } })).json()).totals as Record<string, number>;
    const t0 = (await totals()).composition_created;
    const testTab = new TestTab(); await testTab.open(s.base, `${a.cookie}; gbk_test=1`);
    testTab.send({ type: "user_message", clientMessageId: "u1", text: "go" }); await testTab.waitFor("run_completed"); testTab.close();
    assert.equal((await totals()).composition_created, t0);
    const tab = new TestTab(); await tab.open(s.base, a.cookie);
    tab.send({ type: "user_message", clientMessageId: "u2", text: "go" }); await tab.waitFor("run_completed"); tab.close();
    assert.equal((await totals()).composition_created, t0 + 1);
  } finally { await s.app.close(); }
});
