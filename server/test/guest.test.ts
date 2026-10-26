import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildApp } from "../src/app.ts";
import { testConfig, ScriptModel, reply } from "./helpers.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const jwt = (claims: object) => { const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1" })).toString("base64url"); const p = Buffer.from(JSON.stringify(claims)).toString("base64url"); return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`; };
const now = () => Math.floor(Date.now() / 1000);
const fakeFetch = (async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
const project = JSON.parse(readFileSync(new URL("../../test/fixtures/social-song.json", import.meta.url), "utf8"));
const J = { "content-type": "application/json" };

test("guest accounts: create, idempotent per device, digit-suffixed collision, 422s, limits, rate limit, link + merge upgrade", async () => {
  const cfg = testConfig({ COMPOSER_PUBLIC_ORIGIN: "http://composer.test", GOOGLE_IOS_CLIENT_IDS: "ios-client" });
  const b = await buildApp(cfg, { model: new ScriptModel([() => reply("x")]), persist: false, logger: false, fetch: fakeFetch });
  b.app.addHook("preClose", (done) => { b.app.server.closeAllConnections?.(); done(); });
  await b.app.listen({ port: 0, host: "127.0.0.1" }); const base = `http://127.0.0.1:${(b.app.server.address() as { port: number }).port}`;
  const post = (path: string, body: unknown, h: Record<string, string> = {}) => fetch(`${base}${path}`, { method: "POST", headers: { ...J, ...h }, body: JSON.stringify(body) });
  const anon = (deviceId: string, username: string) => post("/api/auth/anonymous", { deviceId, username });
  try {
    const r1 = await anon("device-aaaaaaaaaaaa-1", "MellowFox"); assert.equal(r1.status, 200); const g1 = await r1.json();
    assert.ok(g1.token && g1.token === g1.access_token && g1.refreshToken === g1.refresh_token);
    assert.equal(g1.user.handle, "mellowfox"); assert.equal(g1.user.display_name, "MellowFox"); assert.equal(g1.user.is_guest, true); assert.equal(g1.user.provider, "guest");
    // idempotent: same device, any username -> same guest, never 409
    const again = await (await anon("device-aaaaaaaaaaaa-1", "OtherName")).json(); assert.equal(again.user.id, g1.user.id); assert.equal(again.user.handle, "mellowfox");
    // collision on a new device
    const c = await anon("device-bbbbbbbbbbbb-2", "MellowFox"); assert.equal(c.status, 200); const cj = await c.json(); assert.equal(cj.user.handle, "mellowfox2"); assert.equal(cj.user.display_name, "MellowFox");
    // invalid
    for (const u of ["mellowfox", "Mellow Fox", "Mellow1Fox", "MellowFoxBlue", "AB", "MELLOWFOX"]) assert.equal((await anon("device-cccccccccccc-3", u)).status, 422, u);
    assert.equal((await anon("short", "BraveOwl")).status, 422);
    // guest can read me, comment and rate; cannot publish
    const A = { authorization: `Bearer ${g1.token}` };
    const me = await (await fetch(`${base}/api/me`, { headers: A })).json(); assert.equal(me.is_guest, true);
    assert.equal((await post("/api/shares", { title: "g", project, public: true }, A)).status, 200);
    const priv = await post("/api/shares", { title: "g", project }, A); assert.equal(priv.status, 200);
    // a public song by a real account (google) to rate/comment
    const gtok = (sub: string) => jwt({ iss: "https://accounts.google.com", aud: "ios-client", sub, exp: now() + 600, name: `G ${sub}`, email: `${sub}@x.test`, email_verified: true });
    const owner = await (await post("/api/auth/google/native", { idToken: gtok("owner1") })).json(); const O = { authorization: `Bearer ${owner.access_token}` };
    const song = await (await post("/api/shares", { title: "Pub", project, public: true }, O)).json();
    assert.equal((await fetch(`${base}/api/shares/${song.slug}/rating`, { method: "PUT", headers: { ...J, ...A }, body: JSON.stringify({ stars: 4 }) })).status, 200);
    assert.equal((await post(`/api/shares/${song.slug}/comments`, { body: "guest says hi" }, A)).status, 200);
    // settings: two-word rule while a guest
    assert.equal((await fetch(`${base}/api/me/settings`, { method: "PATCH", headers: { ...J, ...A }, body: JSON.stringify({ display_name: "not two words" }) })).status, 422);
    // upgrade linked: new google identity keeps the guest id + handle; old refresh token revoked
    const up = await (await post("/api/auth/google/native", { idToken: gtok("newbie") }, A)).json();
    assert.equal(up.upgraded, "linked"); assert.equal(up.me.id, g1.user.id); assert.equal(up.me.handle, "mellowfox"); assert.equal(up.me.is_guest, false);
    assert.equal((await post("/api/auth/refresh", { refresh_token: g1.refresh_token })).status, 401);
    // upgrade merged: second guest rates + comments, then signs in as the existing owner account
    const g2 = await (await anon("device-dddddddddddd-4", "BraveOwl")).json(); const A2 = { authorization: `Bearer ${g2.token}` };
    await post(`/api/shares/${song.slug}/comments`, { body: "from owl" }, A2);
    const m = await (await post("/api/auth/google/native", { idToken: gtok("owner1") }, A2)).json();
    assert.equal(m.upgraded, "merged"); assert.equal(m.me.id, owner.me.id);
    const cm = await (await fetch(`${base}/api/shares/${song.slug}/comments`)).json(); assert.ok(cm.items.some((x: { body: string; author: { handle: string } }) => x.body === "from owl" && x.author.handle === owner.me.handle));
    assert.equal((await fetch(`${base}/api/users/braveowl`)).status, 404);
    // invalid bearer is ignored
    const plain = await (await post("/api/auth/google/native", { idToken: gtok("third") }, { authorization: "Bearer junk" })).json(); assert.equal(plain.upgraded, undefined);
    // rate limit: 20 calls per IP per hour (incl. idempotent repeats)
    let last = 200; for (let i = 0; i < 25; i++) last = (await anon("device-aaaaaaaaaaaa-1", "MellowFox")).status; assert.equal(last, 429);
  } finally { await b.app.close(); }
});
