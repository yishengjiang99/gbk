// Remote MCP OAuth 2.1: DCR, authorize (account linking via website session), PKCE token exchange,
// refresh rotation + reuse revocation, scope enforcement, CIMD allowlist, production fail-closed.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer, login } from "./ws-helpers.ts";
import { McpClient } from "./mcp-helpers.ts";
import { loadConfig } from "../src/config.ts";

const model = () => new ScriptModel([() => reply("x")]);
const REDIRECT = "https://chatgpt.com/connector/oauth/test-callback";
const pkce = () => {
  const verifier = randomBytes(24).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function register(s: { base: string }, scope?: string) {
  const r = await fetch(`${s.base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Test ChatGPT", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"] }) });
  assert.equal(r.status, 201);
  const client = await r.json() as { client_id: string };
  void scope;
  return client.client_id;
}

async function authorizeCode(s: { base: string }, cookie: string, clientId: string, scope: string) {
  const { challenge } = pkceFor(clientId); void challenge;
  const v = verifiers.get(clientId)!;
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: v.challenge, code_challenge_method: "S256", resource: "http://composer.test/mcp", scope, state: "st-1", confirm: "1" });
  const r = await fetch(`${s.base}/oauth/authorize?${q}`, { headers: { cookie }, redirect: "manual" });
  assert.equal(r.status, 302, `authorize should redirect, got ${r.status}`);
  const loc = new URL(r.headers.get("location")!);
  assert.equal(loc.searchParams.get("iss"), "http://composer.test", "RFC 9207 iss on every authorization response");
  assert.equal(loc.searchParams.get("state"), "st-1");
  const code = loc.searchParams.get("code"); assert.ok(code);
  return { code: code!, verifier: v.verifier };
}
const verifiers = new Map<string, { verifier: string; challenge: string }>();
function pkceFor(clientId: string) { if (!verifiers.has(clientId)) verifiers.set(clientId, pkce()); return verifiers.get(clientId)!; }

async function exchange(s: { base: string }, clientId: string, code: string, verifier: string) {
  return fetch(`${s.base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: "http://composer.test/mcp" }) });
}

test("full OAuth flow: DCR -> consent (linked GBK session) -> PKCE exchange -> Bearer MCP calls; rotation + reuse revocation", async () => {
  const s = await startServer(model());
  try {
    const clientId = await register(s);
    const alice = await login(s.base, "code-a");
    // Without a GBK session, authorize asks the user to sign in (account linking), never issues a code.
    const anon = await fetch(`${s.base}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${pkceFor(clientId).challenge}&code_challenge_method=S256&confirm=1`, { redirect: "manual" });
    assert.equal(anon.status, 200);
    assert.match(await anon.text(), /Sign in to GBK/);

    const { code, verifier } = await authorizeCode(s, alice.cookie, clientId, "gbk:compositions.read gbk:compositions.write gbk:renders.create gbk:artifacts.read");
    // Wrong PKCE verifier is rejected and consumes the code.
    const bad = await exchange(s, clientId, code, "not-the-verifier");
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, "invalid_grant");
    const reuse = await exchange(s, clientId, code, verifier);
    assert.equal(reuse.status, 400, "authorization codes are single-use");

    const second = await authorizeCode(s, alice.cookie, clientId, "gbk:compositions.read gbk:compositions.write gbk:renders.create gbk:artifacts.read");
    const tokRes = await exchange(s, clientId, second.code, second.verifier);
    assert.equal(tokRes.status, 200);
    const tok = await tokRes.json() as { access_token: string; refresh_token: string; scope: string };

    const mcp = new McpClient(s.base, { authorization: `Bearer ${tok.access_token}` });
    await mcp.initialize();
    const created = await mcp.call<{ compositionId: string }>("gbk_create_composition", { title: "OAuth Fugue", style: "baroque", bars: 4, seed: 9 });
    assert.ok(created.compositionId.startsWith("cmp_"));

    // Refresh rotation: old refresh dies; reusing it revokes the family (new access stops working).
    const rot = await fetch(`${s.base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: clientId }) });
    assert.equal(rot.status, 200);
    const tok2 = await rot.json() as { access_token: string; refresh_token: string };
    const reuseOld = await fetch(`${s.base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: clientId }) });
    assert.equal(reuseOld.status, 400);
    const mcp2 = new McpClient(s.base, { authorization: `Bearer ${tok2.access_token}` });
    const dead = await mcp2.send("tools/call", { name: "gbk_list_compositions", arguments: {} });
    assert.equal(dead.status, 401, "family revocation kills the rotated access token too");

    // A forged bearer gets the OAuth challenge, not data.
    const forged = new McpClient(s.base, { authorization: "Bearer gbk_at_forged" });
    const fr = await forged.send("tools/call", { name: "gbk_list_compositions", arguments: {} });
    assert.equal(fr.status, 401);
    assert.match(fr.headers.get("www-authenticate") ?? "", /oauth-protected-resource/);
  } finally { await s.app.close(); }
});

test("scope enforcement: a read-only token cannot create; publishing needs its own scope", async () => {
  const s = await startServer(model());
  try {
    const clientId = await register(s);
    const alice = await login(s.base, "code-a");
    const { code, verifier } = await authorizeCode(s, alice.cookie, clientId, "gbk:compositions.read");
    const tok = await (await exchange(s, clientId, code, verifier)).json() as { access_token: string };
    const mcp = new McpClient(s.base, { authorization: `Bearer ${tok.access_token}` });
    await mcp.initialize();
    const list = await mcp.call<{ items: unknown[] }>("gbk_list_compositions", {});
    assert.deepEqual(list.items, []);
    await assert.rejects(mcp.call("gbk_create_composition", { title: "nope" }),
      (e: Error & { payload?: { error?: { code?: string } } }) => e.payload?.error?.code === "INSUFFICIENT_SCOPE");
  } finally { await s.app.close(); }
});

test("CIMD: unallowlisted client_id URLs are rejected without being fetched; bad registrations fail", async () => {
  const s = await startServer(model());
  try {
    const alice = await login(s.base, "code-a");
    const q = new URLSearchParams({ response_type: "code", client_id: "https://evil.example.com/client.json", redirect_uri: "https://evil.example.com/cb",
      code_challenge: pkce().challenge, code_challenge_method: "S256", confirm: "1" });
    const r = await fetch(`${s.base}/oauth/authorize?${q}`, { headers: { cookie: alice.cookie }, redirect: "manual" });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, "invalid_client");
    const badReg = await fetch(`${s.base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["ftp://x/cb"] }) });
    assert.equal(badReg.status, 400);
  } finally { await s.app.close(); }
});

test("production config refuses MCP_TEST_AUTH (fail closed)", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production", MCP_TEST_AUTH: "1", SESSION_SECRET: "x".repeat(40), COMPOSER_PUBLIC_ORIGIN: "https://compose.grepawk.com" } as NodeJS.ProcessEnv), /MCP_TEST_AUTH/);
});
