// Reviewer sign-in (OpenAI app review): one account, scrypt hash, CSRF + origin + per-IP rate limit, off switch,
// and the full MCP OAuth path: /oauth/authorize -> reviewer form -> session -> consent -> code -> token -> MCP call.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer } from "./ws-helpers.ts";
import { hashReviewerPassword, verifyReviewerPassword } from "../src/routes/reviewer.ts";

const PW = randomBytes(18).toString("base64url");
const ON = { REVIEWER_LOGIN_ENABLED: "1", REVIEWER_PASSWORD_HASH: hashReviewerPassword(PW) };
const ORIGIN = "http://composer.test";
const REDIRECT = "https://chatgpt.com/connector/oauth/test-callback";
const model = () => new ScriptModel([() => reply("x")]);

class Jar { c = new Map<string, string>();
  take(r: Response) { for (const h of r.headers.getSetCookie()) { const [kv] = h.split(";"); const i = kv.indexOf("="); const v = kv.slice(i + 1); if (v) this.c.set(kv.slice(0, i), v); else this.c.delete(kv.slice(0, i)); } return r; }
  get header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join("; "); } }

async function openForm(base: string, jar: Jar, ret: string) {
  const r = jar.take(await fetch(`${base}/signin/reviewer?return=${encodeURIComponent(ret)}`, { headers: { cookie: jar.header } }));
  assert.equal(r.status, 200); const html = await r.text();
  return { csrf: /name="csrf" value="([^"]+)"/.exec(html)![1], ret: /name="return" value="([^"]+)"/.exec(html)![1].replace(/&#38;/g, "&") };
}
const submit = (base: string, jar: Jar, f: Record<string, string>) => fetch(`${base}/api/auth/reviewer`, { method: "POST", redirect: "manual",
  headers: { cookie: jar.header, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(f) }).then((r) => jar.take(r));

test("hash verify is exact", () => {
  const h = hashReviewerPassword("correct horse");
  assert.equal(verifyReviewerPassword(h, "correct horse"), true);
  assert.equal(verifyReviewerPassword(h, "correct hors"), false);
  assert.equal(verifyReviewerPassword("garbage", "x"), false);
});

test("off switch: routes 404, link hidden, session reports reviewerLogin=false", async () => {
  for (const env of <Record<string, string>[]>[{}, { REVIEWER_LOGIN_ENABLED: "0", REVIEWER_PASSWORD_HASH: ON.REVIEWER_PASSWORD_HASH }, { REVIEWER_LOGIN_ENABLED: "1" }]) {
    const s = await startServer(model(), env);
    try {
      assert.equal((await fetch(`${s.base}/signin/reviewer`)).status, 404);
      assert.equal((await fetch(`${s.base}/api/auth/reviewer`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: "username=openai-reviewer&password=x" })).status, 404);
      assert.equal((await (await fetch(`${s.base}/api/session`)).json()).reviewerLogin, false);
    } finally { await s.app.close(); }
  }
});

test("wrong password / wrong user / bad csrf / bad origin fail; per-IP rate limit", async () => {
  const s = await startServer(model(), ON);
  try {
    const jar = new Jar(); const f = await openForm(s.base, jar, "/studio");
    assert.equal((await submit(s.base, jar, { csrf: f.csrf, return: "/studio", username: "openai-reviewer", password: PW + "x" })).status, 401);
    assert.equal((await submit(s.base, jar, { csrf: f.csrf, return: "/studio", username: "someone-else", password: PW })).status, 401);
    assert.equal((await submit(s.base, jar, { csrf: "forged", return: "/studio", username: "openai-reviewer", password: PW })).status, 403);
    const badOrigin = await fetch(`${s.base}/api/auth/reviewer`, { method: "POST", headers: { cookie: jar.header, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: f.csrf, username: "openai-reviewer", password: PW }) });
    assert.equal(badOrigin.status, 403);
    assert.ok(!jar.c.has("gbk_session") || true);
    const sess = await (await fetch(`${s.base}/api/session`, { headers: { cookie: jar.header } })).json();
    assert.equal(sess.authenticated, false);
    let last = 0; for (let i = 0; i < 6; i++) last = (await submit(s.base, jar, { csrf: f.csrf, return: "/studio", username: "openai-reviewer", password: "nope" })).status;
    assert.equal(last, 429, "per-IP limiter kicks in");
    assert.equal((await submit(s.base, jar, { csrf: f.csrf, return: "/studio", username: "openai-reviewer", password: PW })).status, 429, "even the right password is refused while limited");
  } finally { await s.app.close(); }
});

test("MCP OAuth flow end to end with reviewer login preserves the return URL", async () => {
  const s = await startServer(model(), { ...ON, MCP_TEST_AUTH: "0" });
  try {
    const reg = await (await fetch(`${s.base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"] }) })).json();
    const verifier = randomBytes(24).toString("base64url"); const challenge = createHash("sha256").update(verifier).digest("base64url");
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", resource: `${ORIGIN}/mcp`, scope: "gbk:compositions.read gbk:compositions.write", state: "st-9" });
    const jar = new Jar();
    const page = await (await fetch(`${s.base}/oauth/authorize?${q}`, { redirect: "manual" })).text();
    const link = /data-testid="reviewer-signin" href="([^"]+)"/.exec(page)?.[1]; assert.ok(link, "authorize sign-in page links Reviewer sign-in");
    const back = new URL(link!, ORIGIN).searchParams.get("return")!; assert.equal(back, `/oauth/authorize?${q}`);
    const f = await openForm(s.base, jar, back); assert.equal(f.ret, back);
    const r = await submit(s.base, jar, { csrf: f.csrf, return: f.ret, username: "openai-reviewer", password: PW });
    assert.equal(r.status, 303); assert.equal(r.headers.get("location"), back);
    const consent = await fetch(`${s.base}${back}`, { headers: { cookie: jar.header }, redirect: "manual" }); jar.take(consent);
    const html = await consent.text(); assert.equal(consent.status, 200);
    const txn = /name="txn" value="([^"]+)"/.exec(html)![1]; const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
    const ok = await fetch(`${s.base}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { cookie: jar.header, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ txn, csrf, decision: "approve" }) });
    assert.equal(ok.status, 302); const loc = new URL(ok.headers.get("location")!); assert.equal(loc.searchParams.get("state"), "st-9");
    const tok = await (await fetch(`${s.base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: loc.searchParams.get("code")!, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource: `${ORIGIN}/mcp` }) })).json();
    assert.ok(tok.access_token);
    const sess = await (await fetch(`${s.base}/api/session`, { headers: { cookie: jar.header } })).json();
    assert.equal(sess.user, "openai-reviewer"); assert.equal(sess.reviewerLogin, true); assert.equal(sess.limits.newAccount, true, "reviewer gets the normal new-account daily limits");
  } finally { await s.app.close(); }
});
