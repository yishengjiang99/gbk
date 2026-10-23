import test from "node:test";
import assert from "node:assert/strict";
import { ScriptModel, reply, testConfig } from "./helpers.ts";
import { startServer, login, TestTab } from "./ws-helpers.ts";
import { SessionStore } from "../src/security/authentication.ts";
import { RateLimiter } from "../src/security/rate-limit.ts";
import { loadConfig } from "../src/config.ts";

test("health exposes no secrets", async () => {
  const s = await startServer(new ScriptModel([() => reply("x")]));
  try {
    const h = await (await fetch(`${s.base}/api/health`)).text();
    assert.match(h, /"ok":true/); for (const secret of ["fake-key", "code-a", "x".repeat(40), "http://fake"]) assert.ok(!h.includes(secret));
    const c = await (await fetch(`${s.base}/api/config`)).text(); assert.ok(!c.includes("fake-key") && !c.includes("code-a"));
  } finally { await s.app.close(); }
});

test("cookies are HttpOnly + SameSite=Strict (+Secure on https); CSRF required for writes", async () => {
  const s = await startServer(new ScriptModel([() => reply("x")]));
  try {
    const r = await fetch(`${s.base}/api/session`); const csrf = (await r.json()).csrf;
    const noCsrf = await fetch(`${s.base}/api/login`, { method: "POST", headers: { "content-type": "application/json", origin: "http://composer.test" }, body: '{"code":"code-a"}' });
    assert.equal(noCsrf.status, 403);
    const ok = await fetch(`${s.base}/api/login`, { method: "POST", headers: { "content-type": "application/json", origin: "http://composer.test", "x-gbk-csrf": csrf, cookie: `gbk_csrf=${csrf}` }, body: '{"code":"code-a"}' });
    const sc = ok.headers.getSetCookie().find((c) => c.startsWith("gbk_cs="))!;
    assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
  } finally { await s.app.close(); }
  const cfg = loadConfig({ COMPOSER_PUBLIC_ORIGIN: "https://compose.grepawk.com", SESSION_SECRET: "y".repeat(40) } as never);
  assert.equal(cfg.security.cookieSecure, true);
  assert.throws(() => loadConfig({ NODE_ENV: "production", SESSION_SECRET: "short" } as never));
});

test("session expiry, forged cookies, idle timeout", () => {
  let now = 1000; const cfg = testConfig({ AGENT_SESSION_IDLE_SECONDS: "10" }); const st = new SessionStore(cfg, () => now);
  const s = st.create("alice"); const v = st.cookieValue(s);
  assert.equal(st.fromCookie(v)?.user, "alice");
  assert.equal(st.fromCookie(`${s.id}.forged`), null);
  assert.equal(st.fromCookie(`other.${v.split(".")[1]}`), null);
  now += 11_000; assert.equal(st.fromCookie(v), null);
  assert.equal(st.checkCode("code-b"), "bob"); assert.equal(st.checkCode("nope"), null); assert.equal(st.checkCode(undefined), null);
});

test("rate limits: login attempts, messages per user, concurrent runs per user", async () => {
  const rl = new RateLimiter(2, 60_000, () => 0); assert.ok(rl.take("k") && rl.take("k")); assert.equal(rl.take("k"), false);
  const s = await startServer(new ScriptModel([async () => { await new Promise((r) => setTimeout(r, 300)); return reply("slow"); }]), { RATE_LOGIN_PER_MINUTE: "3", RATE_MESSAGES_PER_MINUTE: "3" });
  try {
    const codes = [] as number[]; for (let i = 0; i < 5; i++) codes.push((await login(s.base, "wrong")).status);
    assert.deepEqual(codes.slice(3), [429, 429]);
    const s2 = await startServer(new ScriptModel([async () => { await new Promise((r) => setTimeout(r, 300)); return reply("slow"); }]), { RATE_MESSAGES_PER_MINUTE: "2" });
    const a = await login(s2.base, "code-a"); const tab = new TestTab(); await tab.open(s2.base, a.cookie);
    tab.send({ type: "user_message", clientMessageId: "1", text: "a" }); tab.send({ type: "user_message", clientMessageId: "2", text: "b" });
    await tab.waitFor("run_completed");
    tab.send({ type: "user_message", clientMessageId: "3", text: "c" });
    await new Promise((r) => setTimeout(r, 200));
    const errs = tab.events.filter((e) => e.type === "error").map((e) => e.type === "error" && e.code);
    assert.deepEqual(errs, ["RUN_ACTIVE", "RATE_LIMITED"]);
    await s2.app.close();
  } finally { await s.app.close(); }
});

test("off switch: COMPOSER_ENABLED=0 refuses the agent socket", async () => {
  const s = await startServer(new ScriptModel([() => reply("x")]), { COMPOSER_ENABLED: "0" });
  try { const a = await login(s.base, "code-a"); await assert.rejects(new TestTab().open(s.base, a.cookie), /503/); } finally { await s.app.close(); }
});
