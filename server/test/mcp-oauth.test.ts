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

async function consentForm(s: { base: string }, cookie: string, clientId: string, scope: string, extra: Record<string, string> = {}) {
  const v = pkceFor(clientId);
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: v.challenge, code_challenge_method: "S256", resource: "http://composer.test/mcp", scope, state: "st-1", ...extra });
  const r = await fetch(`${s.base}/oauth/authorize?${q}`, { headers: { cookie }, redirect: "manual" });
  assert.equal(r.status, 200, `GET authorize must render the consent form, got ${r.status}`);
  assert.equal(r.headers.get("location"), null, "GET authorize must never redirect with a code");
  const html = await r.text();
  const txn = /name="txn" value="([^"]+)"/.exec(html)?.[1];
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(txn && csrf, "consent form carries txn + csrf hidden fields");
  return { txn: txn!, csrf: csrf!, verifier: v.verifier };
}

async function postConsent(s: { base: string }, cookie: string, fields: Record<string, string>) {
  return fetch(`${s.base}/oauth/authorize`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields), redirect: "manual" });
}

async function authorizeCode(s: { base: string }, cookie: string, clientId: string, scope: string) {
  const { txn, csrf, verifier } = await consentForm(s, cookie, clientId, scope);
  const r = await postConsent(s, cookie, { txn, csrf, decision: "approve" });
  assert.equal(r.status, 302, `consent POST should redirect, got ${r.status}`);
  const loc = new URL(r.headers.get("location")!);
  assert.equal(loc.searchParams.get("iss"), "http://composer.test", "RFC 9207 iss on every authorization response");
  assert.equal(loc.searchParams.get("state"), "st-1");
  const code = loc.searchParams.get("code"); assert.ok(code);
  return { code: code!, verifier };
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
    const anon = await fetch(`${s.base}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${pkceFor(clientId).challenge}&code_challenge_method=S256`, { redirect: "manual" });
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

test("consent cannot be bypassed: GET never mints a code, approval is a single-use CSRF POST bound to the transaction", async () => {
  const s = await startServer(model());
  try {
    const clientId = await register(s);
    const alice = await login(s.base, "code-a");
    const bob = await login(s.base, "code-b");
    const scope = "gbk:compositions.read";

    // The old confirm=1 GET shortcut is gone: a signed-in user following an attacker-crafted
    // authorize link only ever sees the consent form — no redirect, no code.
    const form = await consentForm(s, alice.cookie, clientId, scope, { confirm: "1" });

    // Wrong CSRF token: rejected, and the attempt consumes the transaction.
    const badCsrf = await postConsent(s, alice.cookie, { txn: form.txn, csrf: "forged", decision: "approve" });
    assert.equal(badCsrf.status, 400);
    const replayAfterBad = await postConsent(s, alice.cookie, { txn: form.txn, csrf: form.csrf, decision: "approve" });
    assert.equal(replayAfterBad.status, 400, "any POST attempt consumes the consent transaction");

    // Another signed-in user cannot approve Alice's transaction.
    const form2 = await consentForm(s, alice.cookie, clientId, scope);
    const crossUser = await postConsent(s, bob.cookie, { txn: form2.txn, csrf: form2.csrf, decision: "approve" });
    assert.equal(crossUser.status, 403);

    // Tampered POST fields cannot widen the grant: the code is minted from the stored transaction,
    // so a forged scope in the body is ignored and the token carries the consented scope only.
    const form3 = await consentForm(s, alice.cookie, clientId, scope);
    const ok = await postConsent(s, alice.cookie, { txn: form3.txn, csrf: form3.csrf, decision: "approve", scope: "gbk:shares.publish" });
    assert.equal(ok.status, 302);
    const code = new URL(ok.headers.get("location")!).searchParams.get("code")!;
    const tokRes = await exchange(s, clientId, code, form3.verifier);
    assert.equal(tokRes.status, 200);
    assert.equal((await tokRes.json()).scope, scope, "token scope comes from the consent transaction, never from POST input");

    // A successful approval is single-use too.
    const replay = await postConsent(s, alice.cookie, { txn: form3.txn, csrf: form3.csrf, decision: "approve" });
    assert.equal(replay.status, 400);

    // Deny redirects with access_denied (+ iss/state) and mints nothing.
    const form4 = await consentForm(s, alice.cookie, clientId, scope);
    const denied = await postConsent(s, alice.cookie, { txn: form4.txn, csrf: form4.csrf, decision: "deny" });
    assert.equal(denied.status, 302);
    const dloc = new URL(denied.headers.get("location")!);
    assert.equal(dloc.searchParams.get("error"), "access_denied");
    assert.equal(dloc.searchParams.get("code"), null);
  } finally { await s.app.close(); }
});

test("sessions rebind to the credentials presented per request: narrower token shrinks scopes live, anonymous sessions upgrade", async () => {
  const s = await startServer(model());
  try {
    const clientId = await register(s);
    const alice = await login(s.base, "code-a");
    const full = await authorizeCode(s, alice.cookie, clientId, "gbk:compositions.read gbk:compositions.write gbk:renders.create gbk:artifacts.read");
    const tokFull = (await (await exchange(s, clientId, full.code, full.verifier)).json()) as Record<string, string>;
    const readOnly = await authorizeCode(s, alice.cookie, clientId, "gbk:compositions.read");
    const tokRead = (await (await exchange(s, clientId, readOnly.code, readOnly.verifier)).json()) as Record<string, string>;

    // Session created with the full-scope token can create.
    const mcp = new McpClient(s.base, { authorization: `Bearer ${tokFull.access_token}` });
    await mcp.initialize();
    await mcp.call("gbk_create_composition", { title: "rebind-1" });

    // Same session, same user, narrower token: the write scope is gone on the very next call
    // (before this fix, the session kept the initialize-time scopes for its whole lifetime).
    mcp.setHeaders({ authorization: `Bearer ${tokRead.access_token}` });
    await assert.rejects(mcp.call("gbk_create_composition", { title: "rebind-2" }),
      (e: Error & { payload?: { error?: { code?: string } } }) => e.payload?.error?.code === "INSUFFICIENT_SCOPE");
    const list = await mcp.call<{ items: unknown[] }>("gbk_list_compositions", {});
    assert.equal(list.items.length, 1, "read scope still works on the rebound session");

    // Presenting the full token again restores write access on the same session.
    mcp.setHeaders({ authorization: `Bearer ${tokFull.access_token}` });
    await mcp.call("gbk_create_composition", { title: "rebind-3" });

    // Anonymous session: private tools 401, then the SAME session upgrades when a token arrives
    // (before this fix it 403'd as 'a different user' and forced a reconnect).
    const anon = new McpClient(s.base);
    await anon.initialize();
    const unauth = await anon.callRaw("gbk_create_composition", { title: "nope" });
    assert.equal(unauth.status, 401);
    anon.setHeaders({ authorization: `Bearer ${tokFull.access_token}` });
    const created = await anon.call<{ compositionId: string }>("gbk_create_composition", { title: "upgraded" });
    assert.ok(created.compositionId);
  } finally { await s.app.close(); }
});

test("loopback redirect (RFC 8252 §7.3): any port authorizes; token exchange requires the exact URI sent", async () => {
  const s = await startServer(model());
  try {
    const reg = await fetch(`${s.base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Codex-like", redirect_uris: ["http://127.0.0.1/callback"] }) });
    assert.equal(reg.status, 201);
    const clientId = (await reg.json() as { client_id: string }).client_id;
    const alice = await login(s.base, "code-a");
    const v = pkce();
    const sent = "http://127.0.0.1:52786/callback";
    const auth = (redirect_uri: string) => fetch(`${s.base}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri,
      code_challenge: v.challenge, code_challenge_method: "S256", resource: "http://composer.test/mcp", scope: "gbk:compositions.read", state: "s" })}`,
      { headers: { cookie: alice.cookie }, redirect: "manual" });
    const bad = await auth("http://127.0.0.1:52786/evil");
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, "invalid_redirect_uri");
    const r = await auth(sent);
    assert.equal(r.status, 200);
    const html = await r.text();
    const txn = /name="txn" value="([^"]+)"/.exec(html)![1]; const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
    const p = await postConsent(s, alice.cookie, { txn, csrf, decision: "approve" });
    const loc = new URL(p.headers.get("location")!);
    assert.equal(loc.origin + loc.pathname, sent);
    const code = loc.searchParams.get("code")!;
    const tok = (redirect_uri: string, c: string) => fetch(`${s.base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: c, redirect_uri, client_id: clientId, code_verifier: v.verifier }) });
    const wrong = await tok("http://127.0.0.1/callback", code);
    assert.equal(wrong.status, 400);
    assert.equal((await wrong.json()).error, "invalid_grant");
  } finally { await s.app.close(); }
});
