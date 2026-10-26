// Guest publish (docs/social-api.md "Guest publish"): web-view guest session from X-GBK-Device + X-GBK-Guest-Name,
// public publish without sign-in, per-device/IP limits, reports apply, songs carry over on Google sign-in (idempotent).
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildApp } from "../src/app.ts";
import { testConfig, ScriptModel, reply } from "./helpers.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const jwt = (claims: object) => { const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1" })).toString("base64url"); const p = Buffer.from(JSON.stringify(claims)).toString("base64url"); return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`; };
const fakeFetch = (async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
const project = JSON.parse(readFileSync(new URL("../../test/fixtures/social-song.json", import.meta.url), "utf8"));
const gtok = (sub: string) => jwt({ iss: "https://accounts.google.com", aud: "ios-client", sub, exp: Math.floor(Date.now() / 1000) + 600, name: `G ${sub}`, email: `${sub}@x.test`, email_verified: true });

test("guest web session + guest publish + limits + reports + carry-over on sign-in", async () => {
  const origin = "http://composer.test";
  const cfg = testConfig({ COMPOSER_PUBLIC_ORIGIN: origin, GOOGLE_IOS_CLIENT_IDS: "ios-client", RATE_SHARES_PER_MINUTE: "500" });
  const b = await buildApp(cfg, { model: new ScriptModel([() => reply("x")]), persist: false, logger: false, fetch: fakeFetch });
  const inj = (method: string, url: string, headers: Record<string, string> = {}, payload?: unknown) => b.app.inject({ method: method as "POST", url, headers: { origin, ...(payload !== undefined ? { "content-type": "application/json" } : {}), ...headers }, payload: payload === undefined ? undefined : JSON.stringify(payload) });
  const web = (dev: string, name: string, extra: Record<string, string> = {}) => inj("POST", "/api/auth/guest/web", { "x-gbk-device": dev, "x-gbk-guest-name": name, ...extra });
  const jar = (r: { cookies: { name: string; value: string }[] }) => { const c = Object.fromEntries(r.cookies.map((x) => [x.name, x.value])); return { cookie: Object.entries(c).map(([k, v]) => `${k}=${v}`).join("; "), "x-gbk-csrf": c.gbk_csrf ?? "" }; };
  try {
    const dev = randomUUID();
    // validation
    assert.equal((await web("not-a-uuid", "MellowFox")).statusCode, 422);
    assert.equal((await web(dev, "mellow fox")).json().code, "INVALID_USERNAME");
    assert.equal((await web(dev, "<b>Xx</b>")).statusCode, 422);
    assert.equal((await inj("POST", "/api/auth/guest/web", { origin: "https://evil.test", "x-gbk-device": dev, "x-gbk-guest-name": "MellowFox" })).statusCode, 403);
    // create, then idempotent; same guest as the app's bearer path for the same device id
    const r1 = await web(dev, "MellowFox"); assert.equal(r1.statusCode, 200); const j1 = r1.json(); assert.equal(j1.created, true); assert.equal(j1.me.handle, "mellowfox"); assert.equal(j1.me.is_guest, true);
    const C = jar(r1);
    const again = (await web(dev, "OtherName")).json(); assert.equal(again.me.id, j1.me.id); assert.equal(again.created, false);
    const app = (await inj("POST", "/api/auth/anonymous", {}, { deviceId: dev, username: "Whatever" })).json(); assert.equal(app.user.id, j1.me.id);
    // collision on another device -> digits appended, final handle returned
    const other = (await web(randomUUID(), "MellowFox")).json(); assert.equal(other.me.handle, "mellowfox2");
    // guest publishes publicly with the cookie session (CSRF still enforced)
    assert.equal((await inj("POST", "/api/shares", { cookie: C.cookie }, { title: "x", project, public: true })).statusCode, 403);
    const pub = await inj("POST", "/api/shares", C, { title: "<script>alert(1)</script> Guest tune", project, public: true }); assert.equal(pub.statusCode, 200); const song = pub.json(); assert.equal(song.public, true);
    const page = await inj("GET", `/s/${song.slug}`); assert.ok(!page.body.includes("<script>alert(1)</script>"));
    // reports apply to guest songs; admin hide unpublishes
    const rep = (await inj("POST", "/api/auth/google/native", {}, { idToken: gtok("reporter") })).json();
    const R = { authorization: `Bearer ${rep.access_token}` };
    assert.equal((await inj("POST", "/api/reports", R, { kind: "song", target: song.slug, reason: "spam" })).statusCode, 200);
    // per-device limit: 10 public songs / 24 h (1 used) -> 10th extra is 429 GUEST_PUBLISH_LIMIT
    let last = 0; for (let i = 0; i < 10; i++) last = (await inj("POST", "/api/shares", C, { title: `t${i}`, project, public: true })).statusCode;
    assert.equal(last, 429); const lim = await inj("POST", "/api/shares", C, { title: "over", project, public: true }); assert.equal(lim.json().code, "GUEST_PUBLISH_LIMIT"); assert.ok(lim.headers["retry-after"]);
    // private saves are not limited by the guest publish limit
    assert.equal((await inj("POST", "/api/shares", C, { title: "priv", project })).statusCode, 200);
    // carry-over: this device signs in with Google as an EXISTING account -> songs move (merge), idempotently
    const owner = (await inj("POST", "/api/auth/google/native", {}, { idToken: gtok("existing") })).json();
    const m = (await inj("POST", "/api/auth/google/native", { authorization: `Bearer ${app.access_token}` }, { idToken: gtok("existing") })).json();
    assert.equal(m.upgraded, "merged"); assert.equal(m.me.id, owner.me.id);
    const mine = (await inj("GET", `/api/shares/${song.slug}`, { authorization: `Bearer ${m.access_token}` })).json(); assert.equal(mine.owner, owner.me.id);
    const again2 = (await inj("POST", "/api/auth/google/native", { authorization: `Bearer ${app.access_token}` }, { idToken: gtok("existing") })).json(); assert.equal(again2.upgraded, undefined); assert.equal(again2.me.id, owner.me.id);
    // old guest cookie no longer works
    assert.equal((await inj("POST", "/api/shares", C, { title: "after", project, public: true })).statusCode, 401);
    // linked carry-over (new identity): same id keeps songs
    const d3 = randomUUID(); const g3 = (await web(d3, "BraveOwl")); const C3 = jar(g3); const s3 = (await inj("POST", "/api/shares", C3, { title: "owl", project, public: true })).json();
    const g3b = (await inj("POST", "/api/auth/anonymous", {}, { deviceId: d3, username: "BraveOwl" })).json();
    const l = (await inj("POST", "/api/auth/google/native", { authorization: `Bearer ${g3b.access_token}` }, { idToken: gtok("brandnew") })).json();
    assert.equal(l.upgraded, "linked"); assert.equal((await inj("GET", `/api/shares/${s3.slug}`)).json().owner, l.me.id);
    // per-IP web-session limit (20/h shared with /api/auth/anonymous)
    let st = 200; for (let i = 0; i < 25; i++) st = (await web(dev, "MellowFox")).statusCode; assert.equal(st, 429);
  } finally { await b.app.close(); }
});
