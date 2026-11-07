import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { buildApp } from "../src/app.ts";
import { testConfig, ScriptModel, reply } from "./helpers.ts";
import { ACCESS_TTL_MS } from "../src/routes/native.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const jwt = (claims: object, kid = "k1") => { const h = Buffer.from(JSON.stringify({ alg: "RS256", kid })).toString("base64url"); const p = Buffer.from(JSON.stringify(claims)).toString("base64url"); return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`; };
const now = () => Math.floor(Date.now() / 1000);
const fakeFetch = (async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

async function start() {
  const cfg = testConfig({ COMPOSER_PUBLIC_ORIGIN: "http://composer.test", GOOGLE_IOS_CLIENT_IDS: "ios-client" });
  const b = await buildApp(cfg, { model: new ScriptModel([() => reply("x")]), persist: false, logger: false, fetch: fakeFetch });
  b.app.addHook("preClose", (done) => { b.app.server.closeAllConnections?.(); done(); });
  await b.app.listen({ port: 0, host: "127.0.0.1" });
  return { ...b, base: `http://127.0.0.1:${(b.app.server.address() as { port: number }).port}` };
}
const post = (base: string, path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("native refresh reuse revokes every refresh token but leaves other access sessions alive until TTL", async () => {
  assert.equal(ACCESS_TTL_MS, 3_600_000, "native access TTL is one hour, not a guest-project expiry");
  const s = await start();
  try {
    const mk = () => post(s.base, "/api/auth/google/native", { idToken: jwt({ iss: "https://accounts.google.com", aud: "ios-client", sub: "111", exp: now() + 600, name: "Ana Native", email: "111@x.test", email_verified: true }) }).then((r) => r.json());
    const a1 = await mk(), a2 = await mk();
    assert.equal(a1.expires_in, 3600);
    assert.equal(a2.expires_in, 3600);
    const A1 = { authorization: `Bearer ${a1.access_token}` };
    const A2 = { authorization: `Bearer ${a2.access_token}` };
    assert.equal((await fetch(`${s.base}/api/me`, { headers: A1 })).status, 200);
    assert.equal((await fetch(`${s.base}/api/me`, { headers: A2 })).status, 200);

    const rotated = await (await post(s.base, "/api/auth/refresh", { refresh_token: a1.refresh_token })).json();
    assert.ok(rotated.access_token);
    assert.equal((await fetch(`${s.base}/api/me`, { headers: A1 })).status, 401, "rotation destroys only that refresh's access session");
    assert.equal((await fetch(`${s.base}/api/me`, { headers: { authorization: `Bearer ${rotated.access_token}` } })).status, 200);
    assert.equal((await fetch(`${s.base}/api/me`, { headers: A2 })).status, 200, "a second concurrent access session still works");

    assert.equal((await post(s.base, "/api/auth/refresh", { refresh_token: a1.refresh_token })).status, 401, "reusing the old refresh is rejected");
    assert.equal((await post(s.base, "/api/auth/refresh", { refresh_token: rotated.refresh_token })).status, 401, "reuse also revokes the rotated refresh (family)");
    assert.equal((await post(s.base, "/api/auth/refresh", { refresh_token: a2.refresh_token })).status, 401, "revokeUser deletes every refresh token for the user");
    assert.equal((await fetch(`${s.base}/api/me`, { headers: A2 })).status, 200, "reuse does not call sessions.destroyUser; other access survives until TTL");
  } finally { await s.app.close(); }
});
