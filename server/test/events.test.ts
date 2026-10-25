import test from "node:test";
import assert from "node:assert/strict";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer, login } from "./ws-helpers.ts";
import { WorkstationController } from "../../src/workstation/controller.ts";
import { buildAllTools } from "../../src/webmcp/registry.ts";
import { runTool } from "../../src/webmcp/tools.ts";

const H = (a: { cookie: string; csrf: string }) => ({ "content-type": "application/json", origin: "http://composer.test", "x-gbk-csrf": a.csrf, cookie: `${a.cookie}; gbk_csrf=${a.csrf}` });
async function project(name: string) {
  const c = new WorkstationController(); c.host.checkpoint = async () => {}; const tools = new Map(buildAllTools(c).map((t) => [t.name, t])); const sig = new AbortController().signal;
  await runTool(c, tools.get("gbk_create_project")!, { name }, sig); await runTool(c, tools.get("gbk_generate_arrangement")!, { style: "baroque", bars: 2, seed: 1 }, sig); return { ...c.project, name };
}

test("events: impressions batch (guest cookie, user, bearer-less origin check), model_version on feed, admin metrics", async () => {
  const s = await startServer(new ScriptModel([() => reply("x")]), { COMPOSER_ADMIN_USERS: "alice" });
  try {
    const alice = await login(s.base, "code-a"), bob = await login(s.base, "code-b");
    const slug = (await (await fetch(`${s.base}/api/shares`, { method: "POST", headers: H(alice), body: JSON.stringify({ title: "Ev", project: await project("Ev"), public: true }) })).json()).slug as string;
    const f = await (await fetch(`${s.base}/api/feed`)).json(); assert.match(f.model_version, /^(heur|lr)-/);
    const ev = (o: object) => ({ song: slug, dwell_ms: 5000, listen_ratio: 1, completed: true, model_version: "heur-1", position: 0, ...o });
    // cross-origin cookie beacon rejected
    assert.equal((await fetch(`${s.base}/api/events`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.test" }, body: "{}" })).status, 403);
    // guest: gets a gid cookie, unknown/private songs dropped
    let r = await fetch(`${s.base}/api/events`, { method: "POST", headers: { "content-type": "application/json", origin: "http://composer.test" }, body: JSON.stringify({ session: "sess-guest-1", events: [ev({ dwell_ms: 800, completed: false, listen_ratio: 0.1 }), { song: "nope" }] }) });
    assert.equal(r.status, 200); assert.equal((await r.json()).accepted, 1); assert.match(r.headers.get("set-cookie") ?? "", /gbk_gid=/);
    r = await fetch(`${s.base}/api/events`, { method: "POST", headers: H(bob), body: JSON.stringify({ session: "sess-bob-1", events: [ev({ actions: ["rate", "bogus"] }), ev({ dwell_ms: 3000, listen_ratio: 0.5, completed: false })] }) });
    assert.equal((await r.json()).accepted, 2);
    // v2 signals: like/follow/profile_tap accepted (up to 8 actions), unknown dropped; scroll_v clamped 0..20000 and stored
    r = await fetch(`${s.base}/api/events`, { method: "POST", headers: H(bob), body: JSON.stringify({ session: "sess-bob-2", events: [ev({ actions: ["rate", "like", "follow", "profile_tap", "share", "nope"], scroll_v: 99999 }), ev({ scroll_v: -5 }), ev({ scroll_v: "x" })] }) });
    assert.equal((await r.json()).accepted, 3);
    const rows = s.shares.database.prepare("SELECT actions, scroll_v FROM impressions WHERE session = 'sess-bob-2' ORDER BY id").all() as { actions: string; scroll_v: number | null }[];
    assert.deepEqual(JSON.parse(rows[0].actions), ["rate", "like", "follow", "profile_tap", "share"]); assert.equal(rows[0].scroll_v, 20000); assert.equal(rows[1].scroll_v, 0); assert.equal(rows[2].scroll_v, null);
    s.shares.database.prepare("DELETE FROM impressions WHERE session = 'sess-bob-2'").run();
    // admin metrics
    assert.equal((await fetch(`${s.base}/api/admin/metrics`, { headers: H(bob) })).status, 403);
    const m = await (await fetch(`${s.base}/api/admin/metrics?days=7`, { headers: H(alice) })).json();
    assert.equal(m.impressions, 3); assert.equal(m.sessions, 2); assert.equal(m.actors, 2);
    assert.ok(Math.abs(m.skip_rate - 1 / 3) < 1e-9); assert.ok(Math.abs(m.completion_rate - 1 / 3) < 1e-9); assert.ok(Math.abs(m.positive_action_rate - 1 / 3) < 1e-9);
    assert.equal(m.avg_dwell_ms, Math.round((800 + 5000 + 3000) / 3)); assert.equal(m.avg_watch_ms_per_session, Math.round((800 + 8000) / 2));
    assert.equal(m.by_model[0].model_version, "heur-1");
  } finally { await s.app.close(); }
});
