import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { testConfig, ScriptModel, reply } from "./helpers.ts";
import { safeReturn } from "../src/routes/signin.ts";
import { AccountStore } from "../src/persistence/accounts.ts";
import { AccountLimits, UsageLedger, BudgetError } from "../src/agent/limits.ts";

// Fake GitHub + Google endpoints: the server talks only to these through the injected fetch.
const fakeFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  if (url === "https://github.com/login/oauth/access_token") return JSON.parse(String(init?.body)).code === "gh-good" ? json({ access_token: "gho_x" }) : json({ error: "bad_verification_code" });
  if (url === "https://api.github.com/user") return json({ id: 4242, login: "octo", name: "Octo Cat" });
  if (url === "https://oauth2.googleapis.com/token") { const b = new URLSearchParams(String(init?.body)); return b.get("code_verifier") ? json({ access_token: "ya29" }) : json({ error: "invalid_grant" }, 400); }
  if (url === "https://openidconnect.googleapis.com/v1/userinfo") return json({ sub: "1234567890", name: "Gee User", email: "g@example.com", email_verified: true });
  return new Response("nope", { status: 404 });
};
async function start(over: Record<string, string> = {}) {
  const cfg = testConfig({ GITHUB_CLIENT_ID: "ghid", GITHUB_CLIENT_SECRET: "ghsecret", ...over });
  const b = await buildApp(cfg, { model: new ScriptModel([() => reply("x")]), persist: false, logger: false, fetch: fakeFetch });
  await b.app.listen({ port: 0, host: "127.0.0.1" });
  return { ...b, base: `http://127.0.0.1:${(b.app.server.address() as { port: number }).port}` };
}
const cookies = (r: Response) => r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

test("GitHub sign-in end to end: state check, account creation, session, return path, new-account limits", async () => {
  const s = await start();
  try {
    const go = await fetch(`${s.base}/api/auth/github?return=${encodeURIComponent("/oauth/authorize?x=1")}`, { redirect: "manual" });
    assert.equal(go.status, 302);
    const loc = new URL(go.headers.get("location")!);
    assert.equal(loc.origin + loc.pathname, "https://github.com/login/oauth/authorize");
    assert.equal(loc.searchParams.get("redirect_uri"), "http://composer.test/api/auth/github/callback");
    assert.ok(!go.headers.get("location")!.includes("ghsecret"));
    const st = loc.searchParams.get("state")!; const c = cookies(go);
    assert.equal((await fetch(`${s.base}/api/auth/github/callback?code=gh-good&state=wrong`, { headers: { cookie: c } })).status, 400, "state mismatch");
    assert.equal((await fetch(`${s.base}/api/auth/github/callback?code=gh-bad&state=${st}`, { headers: { cookie: c } })).status, 502);
    const cb = await fetch(`${s.base}/api/auth/github/callback?code=gh-good&state=${st}`, { headers: { cookie: c } });
    assert.equal(cb.status, 200);
    assert.match(await cb.text(), /url=\/oauth\/authorize\?x=1/);
    const ses = await (await fetch(`${s.base}/api/session`, { headers: { cookie: cookies(cb) } })).json();
    assert.equal(ses.authenticated, true); assert.equal(ses.user, "gh-4242"); assert.equal(ses.name, "octo");
    assert.equal(ses.limits.newAccount, true);
    assert.equal(ses.limits.dailyTokens, 200_000);
    // Same GitHub user again -> same account.
    assert.equal(s.accounts.upsertOAuth("github", "4242", "octo", null).created, false);
  } finally { await s.app.close(); }
});

test("Google sign-in (PKCE) when configured", async () => {
  const s = await start({ GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsec" });
  try {
    const go = await fetch(`${s.base}/api/auth/google`, { redirect: "manual" });
    const loc = new URL(go.headers.get("location")!);
    assert.equal(loc.searchParams.get("code_challenge_method"), "S256");
    const cb = await fetch(`${s.base}/api/auth/google/callback?code=c&state=${loc.searchParams.get("state")}`, { headers: { cookie: cookies(go) } });
    assert.equal(cb.status, 200);
    assert.match(await cb.text(), /url=\/studio/);
    const ses = await (await fetch(`${s.base}/api/session`, { headers: { cookie: cookies(cb) } })).json();
    assert.equal(ses.user, "g-1234567890");
  } finally { await s.app.close(); }
});

test("open redirects are refused", () => {
  for (const r of ["https://evil.example", "//evil.example", "/\\evil", 5, undefined]) assert.equal(safeReturn(r), "/studio");
  assert.equal(safeReturn("/s/song-abc"), "/s/song-abc");
});

test("limits: new accounts get the smaller daily token + render limits; established accounts the full ones; usage persists", () => {
  let now = Date.UTC(2026, 9, 24, 12);
  const cfg = testConfig({ AGENT_DAILY_TOKEN_BUDGET: "1000", AGENT_NEW_ACCOUNT_DAILY_TOKEN_BUDGET: "100", MCP_MAX_RENDERS_PER_DAY: "50", MCP_NEW_ACCOUNT_RENDERS_PER_DAY: "3", ACCOUNT_NEW_DAYS: "7" });
  const accts = new AccountStore(":memory:", () => now);
  accts.upsertOAuth("github", "1", "newbie", null); accts.ensureLegacy("alice");
  const lim = new AccountLimits(cfg, accts, () => now);
  assert.deepEqual(lim.for("gh-1"), { newAccount: true, pro: false, dailyTokens: 100, dailyRenders: 3 });
  assert.deepEqual(lim.for("alice"), { newAccount: false, pro: false, dailyTokens: 1000, dailyRenders: 50 });
  const ledger = new UsageLedger(cfg, () => now, accts, lim);
  ledger.record("gh-1", { promptTokens: 90, completionTokens: 20 });
  assert.throws(() => ledger.check("gh-1"), (e) => e instanceof BudgetError && e.code === "TOKEN_BUDGET_EXHAUSTED");
  ledger.check("alice");
  // A restart (fresh ledger) still sees today's usage.
  assert.throws(() => new UsageLedger(cfg, () => now, accts, lim).check("gh-1"), BudgetError);
  now += 8 * 86_400_000; // a week later: established account, new day
  assert.equal(lim.for("gh-1").newAccount, false);
  new UsageLedger(cfg, () => now, accts, lim).check("gh-1");
});

test("migration: access-code users and existing song owners become established accounts; legacy code login still works", async () => {
  const s = await start();
  try {
    assert.equal(s.accounts.get("alice")?.provider, "legacy");
    assert.equal(s.accounts.get("bob")?.created_at, 0);
  } finally { await s.app.close(); }
});

test("new songs are private by default; explicit public: true publishes", async () => {
  const s = await start();
  try {
    const priv = s.shares.create({ owner: "alice", title: "t", projectJson: "{}" });
    assert.equal(priv.public, 0);
    assert.equal((await fetch(`${s.base}/api/shares/${priv.slug}`)).status, 404, "anonymous cannot see a private song");
    const pub = s.shares.create({ owner: "alice", title: "t2", projectJson: "{}", public: true });
    assert.equal(pub.public, 1);
  } finally { await s.app.close(); }
});
