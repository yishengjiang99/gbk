import test from "node:test";
import assert from "node:assert/strict";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer, login } from "./ws-helpers.ts";

const H = (a: { cookie: string; csrf: string }) => ({ "content-type": "application/json", origin: "http://composer.test", "x-gbk-csrf": a.csrf, cookie: `${a.cookie}; gbk_csrf=${a.csrf}` });
import { WorkstationController } from "../../src/workstation/controller.ts";
import { buildAllTools } from "../../src/webmcp/registry.ts";
import { runTool } from "../../src/webmcp/tools.ts";
let base: unknown = null;
async function project(name: string) {
  if (!base) { const c = new WorkstationController(); c.host.checkpoint = async () => {}; const tools = new Map(buildAllTools(c).map((t) => [t.name, t])); const sig = new AbortController().signal;
    await runTool(c, tools.get("gbk_create_project")!, { name }, sig); await runTool(c, tools.get("gbk_generate_arrangement")!, { style: "baroque", bars: 2, seed: 1 }, sig); base = c.project; }
  return { ...(base as object), name };
}

test("social P1: publish meta, feed cursor, ratings, comments, bearer, reports, admin", async () => {
  const s = await startServer(new ScriptModel([() => reply("x")]), { COMPOSER_ADMIN_USERS: "alice" });
  try {
    const alice = await login(s.base, "code-a"), bob = await login(s.base, "code-b");
    const mk = async (t: string, pub = true) => { const r = await fetch(`${s.base}/api/shares`, { method: "POST", headers: H(alice), body: JSON.stringify({ title: t, project: await project(t), public: pub }) }); assert.equal(r.status, 200, await r.clone().text()); return (await r.json()).slug as string; };
    const a = await mk("Fugue One"), b = await mk("Lofi Two"), hidden = await mk("Private", false);
    for (const t of ["A3", "A4", "A5"]) await mk(t);
    // meta
    let r = await fetch(`${s.base}/api/songs/${a}/meta`, { method: "PATCH", headers: H(alice), body: JSON.stringify({ labels: ["classical"], tags: ["Fugue", "piano"] }) });
    assert.equal(r.status, 200); const m = await r.json(); assert.deepEqual(m.tags, ["fugue", "piano"]); assert.deepEqual(m.labels, ["classical"]); assert.equal(m.prompt_shared, false);
    assert.equal((await fetch(`${s.base}/api/songs/${a}/meta`, { method: "PATCH", headers: H(alice), body: JSON.stringify({ labels: ["nope"] }) })).status, 422);
    assert.equal((await fetch(`${s.base}/api/songs/${a}/meta`, { method: "PATCH", headers: H(bob), body: JSON.stringify({ tags: ["x1"] }) })).status, 404);
    await fetch(`${s.base}/api/songs/${b}/meta`, { method: "PATCH", headers: H(alice), body: JSON.stringify({ labels: ["wip"] }) });
    // feed: paginated, private excluded, wip excluded from for_you
    const seen: string[] = []; let cur: string | null = null;
    do { const f = await (await fetch(`${s.base}/api/feed?sort=new&limit=2${cur ? `&cursor=${cur}` : ""}`)).json(); seen.push(...f.items.map((i: { slug: string }) => i.slug)); cur = f.next_cursor; } while (cur);
    assert.equal(seen.length, 5); assert.ok(!seen.includes(hidden)); assert.equal(new Set(seen).size, 5);
    const fy = await (await fetch(`${s.base}/api/feed`)).json(); assert.ok(!fy.items.some((i: { slug: string }) => i.slug === b));
    assert.equal((await (await fetch(`${s.base}/api/feed?label=wip`)).json()).items[0].slug, b);
    assert.equal((await (await fetch(`${s.base}/api/tags/fugue`)).json()).items[0].slug, a);
    assert.equal((await (await fetch(`${s.base}/api/tags/top`)).json()).tags[0].count, 1);
    // ratings
    assert.equal((await fetch(`${s.base}/api/shares/${a}/rating`, { method: "PUT", headers: H(alice), body: JSON.stringify({ stars: 5 }) })).status, 403, "no self-rating");
    assert.equal((await fetch(`${s.base}/api/shares/${a}/rating`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ stars: 5 }) })).status, 401);
    r = await fetch(`${s.base}/api/shares/${a}/rating`, { method: "PUT", headers: H(bob), body: JSON.stringify({ stars: 4 }) }); assert.deepEqual(await r.json(), { rating_avg: 4, rating_count: 1, my_rating: 4 });
    r = await fetch(`${s.base}/api/shares/${a}/rating`, { method: "PUT", headers: H(bob), body: JSON.stringify({ stars: 2 }) }); assert.equal((await r.json()).rating_count, 1);
    // bearer auth (no CSRF/origin) for native clients
    const tok = decodeURIComponent(bob.cookie.split(";").map((c) => c.trim()).find((c) => c.startsWith("gbk_cs="))!.split("=")[1]);
    r = await fetch(`${s.base}/api/shares/${a}/comments`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ body: "<b>nice</b>" }) });
    assert.equal(r.status, 200); const c = await r.json(); assert.equal(c.body, "<b>nice</b>"); assert.equal(c.author.handle.length >= 3, true);
    assert.equal((await fetch(`${s.base}/api/shares/${a}/comments`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer bogus.sig" }, body: JSON.stringify({ body: "x" }) })).status, 401);
    const cl = await (await fetch(`${s.base}/api/shares/${a}/comments`)).json(); assert.equal(cl.items.length, 1); assert.equal(cl.items[0].can_delete, false);
    const song = await (await fetch(`${s.base}/api/songs/${a}`)).json(); assert.equal(song.comment_count, 1); assert.equal(song.rating_avg, 2); assert.equal(song.author.handle, "alice");
    // profile
    const u = await (await fetch(`${s.base}/api/users/alice`)).json(); assert.equal(u.user.song_count, 5); assert.equal(u.songs.length, 5);
    r = await fetch(`${s.base}/api/me/settings`, { method: "PATCH", headers: H(bob), body: JSON.stringify({ handle: "alice" }) }); assert.equal(r.status, 409);
    r = await fetch(`${s.base}/api/me/settings`, { method: "PATCH", headers: H(bob), body: JSON.stringify({ handle: "bobby_b" }) }); assert.equal((await r.json()).handle_changed, true);
    assert.equal((await fetch(`${s.base}/api/me/settings`, { method: "PATCH", headers: H(bob), body: JSON.stringify({ handle: "bobby_c" }) })).status, 403);
    // reports + admin
    r = await fetch(`${s.base}/api/reports`, { method: "POST", headers: H(alice), body: JSON.stringify({ kind: "comment", target: c.id, reason: "spam" }) }); assert.equal(r.status, 200);
    assert.equal((await fetch(`${s.base}/api/admin/reports`, { headers: H(bob) })).status, 403);
    const q = await (await fetch(`${s.base}/api/admin/reports`, { headers: H(alice) })).json(); assert.equal(q.items[0].preview.text, "<b>nice</b>");
    assert.equal((await fetch(`${s.base}/api/admin/reports/${q.items[0].id}`, { method: "POST", headers: H(alice), body: JSON.stringify({ action: "hide" }) })).status, 200);
    assert.equal((await (await fetch(`${s.base}/api/shares/${a}/comments`)).json()).items.length, 0);
    // plays dedupe
    await fetch(`${s.base}/api/shares/${a}/play`, { method: "POST" }); const p2 = await (await fetch(`${s.base}/api/shares/${a}/play`, { method: "POST" })).json(); assert.equal(p2.play_count, 1);
    // backward compat: /api/shares unchanged shape
    const legacy = await (await fetch(`${s.base}/api/shares`)).json(); assert.ok(legacy.shares[0].createdAt && legacy.shares[0].owner);
  } finally { await s.app.close(); }
});
