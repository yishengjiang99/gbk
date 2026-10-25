import test from "node:test";
import assert from "node:assert/strict";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer } from "./ws-helpers.ts";

test("unknown /api routes: 404 with code + Fastify fields; AASA serves the default app id", async () => {
  const s = await startServer(new ScriptModel([() => reply("x")]));
  try {
    const r = await fetch(`${s.base}/api/not-built-yet?x=1`); assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { code: "NOT_FOUND", message: "Route GET:/api/not-built-yet not found", error: "Not Found", statusCode: 404 });
    const a = await fetch(`${s.base}/.well-known/apple-app-site-association`); assert.equal(a.status, 200);
    const j = await a.json(); assert.deepEqual(j.applinks.details[0].appIDs, ["83D36RPMUM.com.grepawk.moviefone"]);
    assert.deepEqual(j.applinks.details[0].components.map((c: { "/": string }) => c["/"]), ["/s/*", "/u/*", "/t/*"]);
    const sess = await (await fetch(`${s.base}/api/session`)).json();
    for (const k of ["authenticated", "user", "name", "provider", "csrf"]) assert.ok(k in sess, k);
  } finally { await s.app.close(); }
});
