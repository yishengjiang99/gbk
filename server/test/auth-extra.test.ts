import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { buildApp } from "../src/app.ts";
import { testConfig, ScriptModel, reply } from "./helpers.ts";
import { e164 } from "../src/routes/auth-extra.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "a1", alg: "RS256" };
const jwt = (c: object) => { const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "a1" })).toString("base64url"); const p = Buffer.from(JSON.stringify(c)).toString("base64url"); return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`; };
const calls: { url: string; body: string; auth: string | null }[] = [];
let turnstileOk = true, approve = "approved";
const fakeFetch = (async (u: string | URL, init?: RequestInit) => {
  const url = String(u); const body = String(init?.body ?? ""); calls.push({ url, body, auth: new Headers(init?.headers).get("authorization") });
  const json = (o: object, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  if (url.includes("appleid.apple.com/auth/keys")) return json({ keys: [jwk] });
  if (url.includes("turnstile")) return json({ success: turnstileOk });
  if (url.endsWith("/Verifications")) return json({ status: "pending" }, 201);
  if (url.endsWith("/VerificationCheck")) return json({ status: approve });
  return json({}, 404);
}) as unknown as typeof fetch;
async function start(env: Record<string, string>) {
  const b = await buildApp(testConfig({ COMPOSER_PUBLIC_ORIGIN: "http://composer.test", ...env }), { model: new ScriptModel([() => reply("x")]), persist: false, logger: false, fetch: fakeFetch });
  b.app.addHook("preClose", (done) => { b.app.server.closeAllConnections?.(); done(); });
  await b.app.listen({ port: 0, host: "127.0.0.1" }); return { ...b, base: `http://127.0.0.1:${(b.app.server.address() as { port: number }).port}` };
}
const J = { "content-type": "application/json" };

test("e164 normalization", () => { assert.equal(e164("(415) 555-0100"), "+14155550100"); assert.equal(e164("+44 20 7946 0958"), "+442079460958"); assert.equal(e164("12"), null); });

test("SMS + Apple web answer 503 until configured", async () => {
  const s = await start({});
  try {
    assert.equal((await fetch(`${s.base}/api/auth/sms/start`, { method: "POST", headers: J, body: JSON.stringify({ phone: "+14155550100", turnstileToken: "t" }) })).status, 503);
    assert.equal((await fetch(`${s.base}/api/auth/sms/verify`, { method: "POST", headers: J, body: JSON.stringify({ phone: "+14155550100", code: "123456" }) })).status, 503);
    assert.equal((await fetch(`${s.base}/api/auth/apple/web`, { redirect: "manual" })).status, 503);
    assert.equal((await (await fetch(`${s.base}/api/auth/sms/config`)).json()).enabled, false);
  } finally { await s.app.close(); }
  // Twilio without Turnstile is still off
  const t = await start({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", TWILIO_VERIFY_SID: "VA1" });
  try { assert.equal((await fetch(`${t.base}/api/auth/sms/start`, { method: "POST", headers: J, body: JSON.stringify({ phone: "+14155550100", turnstileToken: "t" }) })).status, 503); } finally { await t.app.close(); }
});

test("SMS sign-in: Turnstile gate, country allowlist, Twilio Verify start/check, web cookie + native tokens", async () => {
  const s = await start({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", TWILIO_VERIFY_SID: "VA1", TURNSTILE_SECRET: "ts", TURNSTILE_SITE_KEY: "site" });
  const st = (b: object) => fetch(`${s.base}/api/auth/sms/start`, { method: "POST", headers: J, body: JSON.stringify(b) });
  try {
    assert.equal((await (await fetch(`${s.base}/api/auth/sms/config`)).json()).turnstileSiteKey, "site");
    assert.equal((await st({ phone: "+14155550100" })).status, 400, "captcha required");
    assert.equal((await st({ phone: "+442079460958", turnstileToken: "t" })).status, 422, "UK not in allowlist");
    turnstileOk = false; assert.equal((await st({ phone: "+14155550100", turnstileToken: "t" })).status, 403); turnstileOk = true;
    assert.equal(calls.filter((c) => c.url.endsWith("/Verifications")).length, 0, "no SMS sent before captcha passes");
    assert.equal((await st({ phone: "(415) 555-0100", turnstileToken: "t" })).status, 200);
    const v = calls.find((c) => c.url.endsWith("/Verifications"))!;
    assert.match(v.url, /Services\/VA1\/Verifications$/); assert.match(v.body, /To=%2B14155550100/); assert.equal(v.auth, `Basic ${Buffer.from("AC1:tok").toString("base64")}`);
    approve = "pending"; assert.equal((await fetch(`${s.base}/api/auth/sms/verify`, { method: "POST", headers: J, body: JSON.stringify({ phone: "+14155550100", code: "000000" }) })).status, 401); approve = "approved";
    const w = await fetch(`${s.base}/api/auth/sms/verify`, { method: "POST", headers: J, body: JSON.stringify({ phone: "+14155550100", code: "123456" }) });
    assert.equal(w.status, 200); const ck = w.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const me = await (await fetch(`${s.base}/api/me`, { headers: { cookie: ck } })).json(); assert.match(me.id, /^ph-[0-9a-f]{32}$/);
    const n = await (await fetch(`${s.base}/api/auth/sms/verify`, { method: "POST", headers: J, body: JSON.stringify({ phone: "4155550100", code: "123456", client: "native" }) })).json();
    assert.equal(n.me.id, me.id, "same account for the same number"); assert.match(n.refresh_token, /^rt_/);
    for (let i = 0; i < 3; i++) await st({ phone: "+14155550100", turnstileToken: "t" });
    assert.equal((await st({ phone: "+14155550100", turnstileToken: "t" })).status, 429, "per-phone / per-IP send limits");
  } finally { await s.app.close(); }
});

test("Apple web: form_post callback verifies id_token (aud = Services ID, nonce) and signs in", async () => {
  const s = await start({ APPLE_SERVICES_ID: "com.grepawk.gbk.web" });
  try {
    const r = await fetch(`${s.base}/api/auth/apple/web?return=/feed`, { redirect: "manual" }); assert.equal(r.status, 302);
    const loc = new URL(r.headers.get("location")!); assert.equal(loc.searchParams.get("response_mode"), "form_post"); assert.equal(loc.searchParams.get("client_id"), "com.grepawk.gbk.web");
    const stateCookie = r.headers.getSetCookie()[0].split(";")[0]; assert.match(r.headers.getSetCookie()[0], /SameSite=None; Secure/);
    const saved = JSON.parse(Buffer.from(stateCookie.split("=")[1], "base64url").toString());
    const tok = (o: object) => jwt({ iss: "https://appleid.apple.com", aud: "com.grepawk.gbk.web", sub: "000.web", exp: Math.floor(Date.now() / 1000) + 600, nonce: createHash("sha256").update(saved.nonce).digest("hex"), email: "a@privaterelay.appleid.com", email_verified: "true", ...o });
    const post = (form: Record<string, string>, cookie = stateCookie) => fetch(`${s.base}/api/auth/apple/callback`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie }, body: new URLSearchParams(form).toString() });
    assert.equal((await post({ state: "wrong", id_token: tok({}) })).status, 400);
    assert.equal((await post({ state: saved.state, id_token: tok({ nonce: "x" }) })).status, 401);
    assert.equal((await post({ state: saved.state, id_token: tok({ aud: "other" }) })).status, 401);
    const ok = await post({ state: saved.state, id_token: tok({}), user: JSON.stringify({ name: { firstName: "Ann", lastName: "Apple" } }) });
    assert.equal(ok.status, 200); assert.match(await ok.text(), /url=\/feed/);
    const ck = ok.headers.getSetCookie().filter((c) => c.startsWith("gbk_")).map((c) => c.split(";")[0]).join("; ");
    const me = await (await fetch(`${s.base}/api/me`, { headers: { cookie: ck } })).json(); assert.equal(me.id, "ap-000.web"); assert.equal(me.display_name, "Ann Apple");
  } finally { await s.app.close(); }
});
