import test from "node:test";
import assert from "node:assert/strict";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer, login } from "./ws-helpers.ts";
import { WorkstationController } from "../../src/workstation/controller.ts";
import { buildAllTools } from "../../src/webmcp/registry.ts";
import { runTool } from "../../src/webmcp/tools.ts";
import { buildPreview } from "../../src/agent/piano-roll-preview.ts";

const H = (a: { cookie: string; csrf: string }) => ({ "content-type": "application/json", origin: "http://composer.test", "x-gbk-csrf": a.csrf, cookie: `${a.cookie}; gbk_csrf=${a.csrf}` });
async function song(name: string) {
  const c = new WorkstationController(); c.host.checkpoint = async () => {};
  const tools = new Map(buildAllTools(c).map((t) => [t.name, t])); const sig = new AbortController().signal;
  await runTool(c, tools.get("gbk_create_project")!, { name }, sig);
  await runTool(c, tools.get("gbk_generate_arrangement")!, { style: "baroque", bars: 4, seed: 1 }, sig);
  return c.project;
}

test("buildPreview: caps notes, normalizes to 0..1000, colors per track", () => {
  const notes = Array.from({ length: 1000 }, (_, i) => ({ trackId: i % 2 ? "b" : "a", tick: i * 10, duration: 10, pitch: 40 + (i % 30) }));
  const p = buildPreview({ tracks: [{ id: "a", color: "#ff0000" }, { id: "b", color: "bogus" }], notes }, 100);
  assert.equal(p.notes.length, 100); assert.deepEqual(p.tracks, ["#ff0000", "#90a4ae"]);
  assert.equal(p.lo, 40); assert.equal(p.hi, 69);
  for (const [t, x, w] of p.notes) { assert.ok(t === 0 || t === 1); assert.ok(x >= 0 && x <= 1000 && w >= 1); }
  assert.deepEqual(buildPreview({}).notes, []);
});

test("GET /api/shares/top: public only, ranked by forks then newest, light payload", async () => {
  const s = await startServer(new ScriptModel([() => reply("x")]));
  try {
    const alice = await login(s.base, "code-a"), bob = await login(s.base, "code-b");
    const post = async (who: typeof alice, title: string, parentSlug?: string) => (await (await fetch(`${s.base}/api/shares`, { method: "POST", headers: H(who), body: JSON.stringify({ title, project: await song(title), parentSlug }) })).json()) as { slug: string };
    const a = await post(alice, "Old popular"); const b = await post(alice, "Hidden"); const c = await post(alice, "Newest plain");
    await post(bob, "Fork 1", a.slug);
    await fetch(`${s.base}/api/shares/${b.slug}`, { method: "PATCH", headers: H(alice), body: '{"public":false}' });
    const r = await fetch(`${s.base}/api/shares/top`); assert.equal(r.status, 200);
    const body = await r.json(); assert.equal(body.rank, "forks");
    const slugs = body.shares.map((x: { slug: string }) => x.slug);
    assert.equal(slugs[0], a.slug, "most-forked first"); assert.ok(!slugs.includes(b.slug), "private hidden");
    assert.ok(slugs.indexOf(c.slug) > 0);
    for (const sh of body.shares) { assert.ok(sh.preview.notes.length > 0 && sh.preview.notes.length <= 240); assert.equal(sh.project, undefined); assert.equal(sh.wav, null); }
    assert.ok(JSON.stringify(body).length < 60_000);
    assert.equal((await (await fetch(`${s.base}/api/shares/top?limit=500`)).json()).shares.length <= 10, true);
  } finally { await s.app.close(); }
});
