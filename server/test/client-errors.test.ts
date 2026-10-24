import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer, login } from "./ws-helpers.ts";
import { ClientErrorStore } from "../src/persistence/client-errors.ts";

const O = "http://composer.test";
const post = (base: string, body: unknown, h: Record<string, string> = {}) => fetch(`${base}/api/client-errors`, { method: "POST", headers: { "content-type": "application/json", origin: O, ...h }, body: typeof body === "string" ? body : JSON.stringify(body) });
const err = (o: Record<string, unknown> = {}) => ({ kind: "report", message: "boom", stack: "Error: boom\n    at x (a.js:1:2)", url: `${O}/studio?code=SECRET123&state=abc#frag`, userAgent: "UA/1", release: "r1", ts: 123, count: 2, context: { where: "render-job" }, breadcrumbs: ["load /studio"], ...o });

test("client-errors: anonymous ingest is stored, scrubbed and URL-stripped; signed-in user id attached; admin read is owner-only", async () => {
  const s = await startServer(new ScriptModel([() => reply("x")]), { COMPOSER_ADMIN_USERS: "alice" });
  try {
    let r = await post(s.base, { errors: [err({ message: "fetch failed Bearer abcdefghijklmnop token=zzzzzzzz" })] });
    assert.equal(r.status, 202); assert.equal((await r.json()).accepted, 1);
    const bob = await login(s.base, "code-b");
    r = await post(s.base, { errors: [err({ kind: "unhandledrejection", message: "second" })] }, { cookie: bob.cookie });
    assert.equal(r.status, 202);
    const rows = s.clientErrors.list({ limit: 10 });
    assert.equal(rows.length, 2);
    const anon = rows.find((x) => x.message.startsWith("fetch failed"))!;
    assert.equal(anon.user_id, null); assert.equal(anon.url, `${O}/studio`); assert.equal(anon.count, 2); assert.equal(anon.release, "r1");
    assert.doesNotMatch(anon.message, /abcdefghijklmnop|zzzzzzzz/); assert.equal(JSON.parse(anon.context).where, "render-job");
    assert.equal(rows.find((x) => x.message === "second")!.user_id, "bob");
    // admin endpoint
    assert.equal((await fetch(`${s.base}/api/admin/client-errors`)).status, 401);
    assert.equal((await fetch(`${s.base}/api/admin/client-errors`, { headers: { cookie: bob.cookie } })).status, 403);
    const alice = await login(s.base, "code-a");
    const a = await (await fetch(`${s.base}/api/admin/client-errors?limit=5&kind=unhandledrejection`, { headers: { cookie: alice.cookie } })).json();
    assert.equal(a.total, 2); assert.equal(a.errors.length, 1); assert.equal(a.errors[0].message, "second"); assert.deepEqual(a.errors[0].breadcrumbs, ["load /studio"]);
  } finally { await s.app.close(); }
});

test("client-errors: rejects foreign origins, bad bodies and oversize payloads; caps batch and field sizes; rate-limits per IP", async () => {
  const s = await startServer(new ScriptModel([() => reply("x")]));
  try {
    assert.equal((await post(s.base, { errors: [err()] }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await post(s.base, { nope: 1 })).status, 400);
    assert.equal((await post(s.base, { errors: [err({ message: "x".repeat(40_000) })] })).status, 413);
    const r = await post(s.base, { errors: Array.from({ length: 25 }, (_, i) => err({ message: `m${i}`, stack: i === 0 ? "s".repeat(7000) : "short", kind: "weird" })) });
    assert.equal(r.status, 202); assert.equal((await r.json()).accepted, 10);
    const row = s.clientErrors.list({ limit: 20 }).find((x) => x.message === "m0")!; assert.equal(row.stack.length, 6000); assert.equal(row.kind, "report");
    // text/plain body (some beacons) is accepted too
    assert.equal((await post(s.base, JSON.stringify({ errors: [err()] }), { "content-type": "text/plain" })).status, 202);
    let limited = false; for (let i = 0; i < 25 && !limited; i++) limited = (await post(s.base, { errors: [err()] })).status === 429;
    assert.ok(limited, "per-IP limit kicks in");
  } finally { await s.app.close(); }
});

test("client-errors store: migration is idempotent across reopen and rows are pruned to the cap", () => {
  const f = join(mkdtempSync(join(tmpdir(), "gbk-ce-")), "accounts.sqlite");
  const a = new ClientErrorStore(f, 5);
  const row = { client_ts: 1, user_id: null, kind: "error", message: "m", stack: "", url: "", user_agent: "", release: "", count: 1, context: "{}", breadcrumbs: "[]" };
  a.insert(Array.from({ length: 12 }, () => row)); a.close();
  const b = new ClientErrorStore(f, 5); assert.equal(b.count(), 5); b.close();
});
