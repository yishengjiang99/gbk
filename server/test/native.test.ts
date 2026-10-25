import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { buildApp } from "../src/app.ts";
import { testConfig, ScriptModel, reply } from "./helpers.ts";
import type { ApnsSender } from "../src/push/apns.ts";
import { readFileSync } from "node:fs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const jwt = (claims: object, kid = "k1") => { const h = Buffer.from(JSON.stringify({ alg: "RS256", kid })).toString("base64url"); const p = Buffer.from(JSON.stringify(claims)).toString("base64url"); return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`; };
const now = () => Math.floor(Date.now() / 1000);
const fakeFetch = (async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
const project = JSON.parse(readFileSync(new URL("../../test/fixtures/social-song.json", import.meta.url), "utf8"));

async function start(env: Record<string, string>, apns?: ApnsSender) {
  const cfg = testConfig({ COMPOSER_PUBLIC_ORIGIN: "http://composer.test", GOOGLE_IOS_CLIENT_IDS: "ios-client", ...env });
  const b = await buildApp(cfg, { model: new ScriptModel([() => reply("x")]), persist: false, logger: false, fetch: fakeFetch, apns });
  b.app.addHook("preClose", (done) => { b.app.server.closeAllConnections?.(); done(); });
  await b.app.listen({ port: 0, host: "127.0.0.1" });
  return { ...b, base: `http://127.0.0.1:${(b.app.server.address() as { port: number }).port}` };
}
const J = { "content-type": "application/json" };
const post = (base: string, path: string, body: unknown, h: Record<string, string> = {}) => fetch(`${base}${path}`, { method: "POST", headers: { ...J, ...h }, body: JSON.stringify(body) });

test("native: google exchange, bearer, refresh rotation + reuse detection, web-code, push + fan-out, AASA, delete account", async () => {
  const sent: { token: string; payload: { kind?: string } }[] = [];
  const s = await start({ IOS_APP_IDS: "TEAM123.com.grepawk.gbk", APNS_KEY_ID: "x" }, async (token, _env, payload) => { sent.push({ token, payload: payload as { kind?: string } }); return { status: 200, apnsId: "1", reason: null }; });
  try {
    // bad tokens
    assert.equal((await post(s.base, "/api/auth/google/native", { idToken: jwt({ iss: "https://accounts.google.com", aud: "other", sub: "1", exp: now() + 600 }) })).status, 401);
    assert.equal((await post(s.base, "/api/auth/google/native", { idToken: jwt({ iss: "https://accounts.google.com", aud: "ios-client", sub: "1", exp: now() - 600 }) })).status, 401);
    assert.equal((await post(s.base, "/api/auth/google/native", { idToken: jwt({ iss: "https://evil", aud: "ios-client", sub: "1", exp: now() + 600 }) })).status, 401);
    const forged = jwt({ iss: "https://accounts.google.com", aud: "ios-client", sub: "1", exp: now() + 600 }).split("."); forged[1] = Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: "ios-client", sub: "2", exp: now() + 600 })).toString("base64url");
    assert.equal((await post(s.base, "/api/auth/google/native", { idToken: forged.join(".") })).status, 401);
    // good
    const mk = async (sub: string, name: string) => (await (await post(s.base, "/api/auth/google/native", { idToken: jwt({ iss: "https://accounts.google.com", aud: "ios-client", sub, exp: now() + 600, name, email: `${sub}@x.test`, email_verified: true }) })).json());
    const a = await mk("111", "Ana Native"), b = await mk("222", "Ben Native");
    assert.equal(a.token_type, "Bearer"); assert.equal(a.expires_in, 3600); assert.match(a.refresh_token, /^rt_/); assert.equal(a.me.handle, "ananative");
    const A = { authorization: `Bearer ${a.access_token}` }, B = { authorization: `Bearer ${b.access_token}` };
    assert.equal((await (await fetch(`${s.base}/api/me`, { headers: A })).json()).id, "g-111");
    // refresh rotates; reusing the old one revokes the family
    const r1 = await (await post(s.base, "/api/auth/refresh", { refresh_token: a.refresh_token })).json(); assert.ok(r1.access_token);
    assert.equal((await fetch(`${s.base}/api/me`, { headers: A })).status, 401, "old access token revoked by rotation");
    assert.equal((await post(s.base, "/api/auth/refresh", { refresh_token: a.refresh_token })).status, 401);
    assert.equal((await post(s.base, "/api/auth/refresh", { refresh_token: r1.refresh_token })).status, 401, "reuse revoked the family");
    const a2 = await mk("111", "Ana Native"); const A2 = { authorization: `Bearer ${a2.access_token}` };
    // web-view code: single use, sets cookie, safe return only
    assert.equal((await post(s.base, "/api/auth/web-code", {})).status, 401);
    const { code } = await (await post(s.base, "/api/auth/web-code", {}, A2)).json();
    let r = await fetch(`${s.base}/api/auth/web-code/redeem?code=${code}&return=//evil.com`, { redirect: "manual" });
    assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "/studio"); const ck = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "); assert.match(ck, /gbk_cs=/);
    assert.equal((await (await fetch(`${s.base}/api/me`, { headers: { cookie: ck } })).json()).id, "g-111");
    r = await fetch(`${s.base}/api/auth/web-code/redeem?code=${code}`, { redirect: "manual" }); assert.match(r.headers.get("location")!, /signin=expired/);
    // push register + comment/fork notifications
    assert.equal((await post(s.base, "/api/push/register", { installId: "bad", token: "ab", environment: "sandbox" }, A2)).status, 400);
    const tok = "a".repeat(64);
    assert.equal((await post(s.base, "/api/push/register", { installId: "123e4567-e89b-12d3-a456-426614174000", token: tok, environment: "sandbox" }, A2)).status, 200);
    const song = await (await post(s.base, "/api/shares", { title: "Native Song", project, public: true }, A2)).json();
    assert.equal((await post(s.base, `/api/shares/${song.slug}/comments`, { body: "push me" }, B)).status, 200);
    await post(s.base, "/api/shares", { title: "Ben Remix", project, public: true, parentSlug: song.slug }, B);
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(sent.map((x) => [x.token, x.payload.kind]), [[tok, "comment"], [tok, "fork"]]);
    // AASA
    const aasa = await (await fetch(`${s.base}/.well-known/apple-app-site-association`)).json();
    assert.deepEqual(aasa.applinks.details[0].components.map((c: Record<string, string>) => c["/"]), ["/s/*", "/u/*", "/t/*"]);
    // delete account: songs gone, tokens dead
    assert.equal((await fetch(`${s.base}/api/me`, { method: "DELETE", headers: A2 })).status, 200);
    assert.equal((await fetch(`${s.base}/api/songs/${song.slug}`)).status, 404);
    assert.equal((await fetch(`${s.base}/api/me`, { headers: { cookie: ck } })).status, 401);
    assert.equal((await post(s.base, "/api/auth/refresh", { refresh_token: a2.refresh_token })).status, 401);
    assert.equal((await post(s.base, "/api/push/unregister", { installId: "123e4567-e89b-12d3-a456-426614174000" }, B)).status, 200);
  } finally { await s.app.close(); }
});

test("native: Apple answers 503 until configured; verifies nonce + bundle audience when configured", async () => {
  let s = await start({});
  try {
    assert.equal((await post(s.base, "/api/auth/apple", { identityToken: "x", nonce: "n" })).status, 503);
    assert.equal((await fetch(`${s.base}/.well-known/apple-app-site-association`)).status, 404);
  } finally { await s.app.close(); }
  s = await start({ APPLE_BUNDLE_ID: "com.grepawk.gbk" });
  try {
    const nonce = "raw-nonce-1"; const hashed = createHash("sha256").update(nonce).digest("hex");
    const tok = (o: object) => jwt({ iss: "https://appleid.apple.com", aud: "com.grepawk.gbk", sub: "001.apple", exp: now() + 600, nonce: hashed, ...o });
    assert.equal((await post(s.base, "/api/auth/apple", { identityToken: tok({}), nonce: "wrong" })).status, 401);
    assert.equal((await post(s.base, "/api/auth/apple", { identityToken: tok({ aud: "com.other" }), nonce })).status, 401);
    const ok = await (await post(s.base, "/api/auth/apple", { identityToken: tok({}), nonce, displayName: "Apple Ann" })).json();
    assert.equal(ok.me.id, "ap-001.apple"); assert.equal(ok.me.display_name, "Apple Ann");
  } finally { await s.app.close(); }
});
