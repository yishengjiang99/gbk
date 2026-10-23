import test from "node:test";
import assert from "node:assert/strict";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer, login } from "./ws-helpers.ts";
import { WorkstationController } from "../../src/workstation/controller.ts";
import { buildAllTools } from "../../src/webmcp/registry.ts";
import { runTool } from "../../src/webmcp/tools.ts";
import { sanitizeSharedProject } from "../../src/agent/share-schema.ts";

async function song() {
  const c = new WorkstationController(); c.host.checkpoint = async () => {};
  const tools = new Map(buildAllTools(c).map((t) => [t.name, t])); const sig = new AbortController().signal;
  await runTool(c, tools.get("gbk_create_project")!, { name: "Shared Fugue", key: "D minor" }, sig);
  await runTool(c, tools.get("gbk_generate_arrangement")!, { style: "baroque", bars: 4, seed: 1 }, sig);
  return c;
}
const D = (a: { cookie: string; csrf: string }) => { const { "content-type": _c, ...r } = H(a); return r; };
const H = (a: { cookie: string; csrf: string }) => ({ "content-type": "application/json", origin: "http://composer.test", "x-gbk-csrf": a.csrf, cookie: `${a.cookie}; gbk_csrf=${a.csrf}` });

test("share -> open link (public, no login) -> fork lineage -> unshare -> delete", async () => {
  const s = await startServer(new ScriptModel([() => reply("x")]));
  try {
    const alice = await login(s.base, "code-a"), bob = await login(s.base, "code-b");
    const c = await song();
    assert.equal((await fetch(`${s.base}/api/shares`, { method: "POST", headers: { "content-type": "application/json", origin: "http://composer.test" }, body: JSON.stringify({ project: c.project }) })).status, 401);
    const r = await fetch(`${s.base}/api/shares`, { method: "POST", headers: H(alice), body: JSON.stringify({ title: "Alice's fugue", project: c.project }) });
    assert.equal(r.status, 200); const sh = await r.json();
    assert.match(sh.url, /^http:\/\/composer\.test\/s\/alice-s-fugue-[a-z0-9]{8}$/);
    const wav = new Uint8Array(100); wav.set([..."RIFF"].map((x) => x.charCodeAt(0)), 0); wav.set([..."WAVE"].map((x) => x.charCodeAt(0)), 8);
    assert.equal((await fetch(`${s.base}/api/shares/${sh.slug}/media/wav`, { method: "PUT", headers: { ...H(alice), "content-type": "audio/wav", "x-gbk-wav-meta": JSON.stringify({ durationSeconds: 12.5 }) }, body: wav })).status, 200);
    assert.equal((await fetch(`${s.base}/api/shares/${sh.slug}/media/wav`, { method: "PUT", headers: { ...H(bob), "content-type": "audio/wav" }, body: wav })).status, 404, "not bob's share");
    assert.equal((await fetch(`${s.base}/api/shares/${sh.slug}/media/wav`, { method: "PUT", headers: { ...H(alice), "content-type": "audio/wav" }, body: new Uint8Array(100) })).status, 422);
    // anonymous viewer
    const pub = await (await fetch(`${s.base}/api/shares/${sh.slug}`)).json();
    assert.equal(pub.title, "Alice's fugue"); assert.equal(pub.owner, "alice"); assert.equal(pub.hasWav, true); assert.equal(pub.mine, false); assert.equal(pub.wav.durationSeconds, 12.5);
    const viewer = new WorkstationController(); const mine = viewer.project.id;
    viewer.loadShared({ ...sanitizeSharedProject(pub.project), meta: { ...sanitizeSharedProject(pub.project).meta, sharedFrom: { slug: pub.slug, title: pub.title, owner: pub.owner } } });
    assert.notEqual(viewer.project.id, c.project.id); assert.notEqual(viewer.project.id, mine);
    assert.ok(viewer.project.notes.length > 10);
    assert.throws(() => viewer.edit([{ op: "addTrack", name: "x", channel: 1 }]), /read-only/i);
    const forked = viewer.fork(); assert.equal(forked.meta?.forkOf, pub.slug);
    viewer.edit([{ op: "addTrack", name: "Bob's oboe", channel: 5 }]);
    const r2 = await (await fetch(`${s.base}/api/shares`, { method: "POST", headers: H(bob), body: JSON.stringify({ project: viewer.project, parentSlug: forked.meta?.forkOf }) })).json();
    assert.deepEqual(r2.parent, { slug: sh.slug, title: "Alice's fugue", owner: "alice" });
    const list = (await (await fetch(`${s.base}/api/shares`)).json()).shares;
    assert.deepEqual(list.map((x: { slug: string }) => x.slug), [r2.slug, sh.slug]); // newest first
    assert.equal(list[1].forks, 1);
    assert.equal((await fetch(`${s.base}/api/shares/${sh.slug}`, { method: "DELETE", headers: D(bob) })).status, 404, "bob cannot delete alice's");
    const un = await fetch(`${s.base}/api/shares/${sh.slug}`, { method: "PATCH", headers: H(alice), body: '{"public":false}' }); assert.equal(un.status, 200);
    assert.equal((await fetch(`${s.base}/api/shares/${sh.slug}`)).status, 404, "unshared: hidden from the public");
    assert.equal((await fetch(`${s.base}/api/shares/${sh.slug}`, { headers: { cookie: alice.cookie } })).status, 200, "owner still sees it");
    assert.equal((await fetch(`${s.base}/api/shares?mine=1`, { headers: { cookie: alice.cookie } }).then((x) => x.json())).shares.length, 1);
    assert.equal((await fetch(`${s.base}/api/shares/${sh.slug}`, { method: "DELETE", headers: D(alice) })).status, 200);
    const after = await (await fetch(`${s.base}/api/shares/${r2.slug}`)).json(); assert.equal(after.parent, null, "fork survives, lineage cleared");
  } finally { await s.app.close(); }
});

test("validation: malformed / oversized / hostile projects are rejected or cleaned", async () => {
  const c = await song(); const p = structuredClone(c.project);
  assert.throws(() => sanitizeSharedProject({ ...p, notes: [{ ...p.notes[0], pitch: 300 }] }), /pitch|expected integer/);
  assert.throws(() => sanitizeSharedProject({ ...p, notes: [{ ...p.notes[0], trackId: "ghost" }] }), /unknown track/);
  assert.throws(() => sanitizeSharedProject({ ...p, schemaVersion: 99 }), /schemaVersion/);
  assert.throws(() => sanitizeSharedProject({ ...p, tracks: Array.from({ length: 65 }, () => p.tracks[0]) }), /more than 64/);
  const clean = sanitizeSharedProject({ ...p, raw: [{ id: "r", trackId: p.tracks[0].id, tick: 0, bytes: [0xf0, 1, 2], kind: "sysex" }], evil: "<script>", tracks: p.tracks.map((t) => ({ ...t, color: "red;background:url(x)" })) });
  assert.equal(clean.raw.length, 0); assert.equal((clean as never as Record<string, unknown>).evil, undefined); assert.equal(clean.tracks[0].color, "#90a4ae");
  const s = await startServer(new ScriptModel([() => reply("x")]));
  try {
    const a = await login(s.base, "code-a");
    assert.equal((await fetch(`${s.base}/api/shares`, { method: "POST", headers: H(a), body: JSON.stringify({ project: { ...p, ppq: -1 } }) })).status, 422);
    assert.equal((await fetch(`${s.base}/api/shares`, { method: "POST", headers: H(a), body: JSON.stringify({ project: p, pad: "x".repeat(7 * 1024 * 1024) }) })).status, 413);
    const codes: number[] = []; for (let i = 0; i < 12; i++) codes.push((await fetch(`${s.base}/api/shares`, { method: "POST", headers: H(a), body: JSON.stringify({ project: p }) })).status);
    assert.ok(codes.includes(429), "upload rate limit");
  } finally { await s.app.close(); }
});

test("auto-save is PRIVATE: invisible to others/anonymous until the owner publishes with a title; forks start private", async () => {
  const s = await startServer(new ScriptModel([() => reply("Nocturne in D Minor")]));
  try {
    const alice = await login(s.base, "code-a"), bob = await login(s.base, "code-b");
    const c = await song();
    assert.equal((await fetch(`${s.base}/api/songs/autosave`, { method: "PUT", headers: { "content-type": "application/json", origin: "http://composer.test" }, body: JSON.stringify({ project: c.project }) })).status, 401);
    const a1 = await (await fetch(`${s.base}/api/songs/autosave`, { method: "PUT", headers: H(alice), body: JSON.stringify({ project: c.project }) })).json();
    assert.equal(a1.public, false); assert.equal(a1.created, true); assert.equal(a1.owner, "alice");
    // a later revision updates the same row (latest version only)
    const a2 = await (await fetch(`${s.base}/api/songs/autosave`, { method: "PUT", headers: H(alice), body: JSON.stringify({ project: { ...c.project, revision: c.project.revision + 1 } }) })).json();
    assert.equal(a2.slug, a1.slug); assert.equal(a2.created, false); assert.equal(a2.public, false);
    // private: not in public explore, not readable by anonymous or bob (no media either), but in alice's "mine"
    const pubList = (await (await fetch(`${s.base}/api/shares`)).json()).shares as { slug: string }[];
    assert.ok(!pubList.some((x) => x.slug === a1.slug), "private song must not be on Explore");
    assert.ok(!(await (await fetch(`${s.base}/api/shares?mine=1`, { headers: H(bob) })).json()).shares.some((x: { slug: string }) => x.slug === a1.slug));
    assert.equal((await fetch(`${s.base}/api/shares/${a1.slug}`)).status, 404);
    assert.equal((await fetch(`${s.base}/api/shares/${a1.slug}`, { headers: H(bob) })).status, 404);
    assert.equal((await fetch(`${s.base}/api/shares/${a1.slug}/media/midi`)).status, 404);
    const mine = (await (await fetch(`${s.base}/api/shares?mine=1`, { headers: H(alice) })).json()).shares;
    assert.equal(mine.length, 1); assert.equal(mine[0].public, false);
    // bob cannot suggest/publish alice's song
    assert.equal((await fetch(`${s.base}/api/songs/${a1.slug}/suggest-title`, { method: "POST", headers: H(bob), body: "{}" })).status, 404);
    assert.equal((await fetch(`${s.base}/api/shares/${a1.slug}`, { method: "PATCH", headers: H(bob), body: JSON.stringify({ public: true }) })).status, 404);
    // AI title suggestion, then explicit publish with the (edited) title
    const sug = await (await fetch(`${s.base}/api/songs/${a1.slug}/suggest-title`, { method: "POST", headers: H(alice), body: "{}" })).json();
    assert.equal(sug.title, "Nocturne in D Minor"); assert.equal(sug.source, "ai");
    assert.equal((await fetch(`${s.base}/api/shares/${a1.slug}`, { method: "PATCH", headers: H(alice), body: JSON.stringify({ title: "  " }) })).status, 400);
    const pubd = await (await fetch(`${s.base}/api/shares/${a1.slug}`, { method: "PATCH", headers: H(alice), body: JSON.stringify({ public: true, title: sug.title }) })).json();
    assert.equal(pubd.public, true); assert.equal(pubd.title, "Nocturne in D Minor");
    const anon = await (await fetch(`${s.base}/api/shares/${a1.slug}`)).json(); assert.equal(anon.title, "Nocturne in D Minor");
    // publishing with a title moves the slug to "<kebab-title>-<id>"; the pre-publish slug still resolves
    assert.equal(pubd.slug, `nocturne-in-d-minor-${a1.slug.slice(-8)}`); assert.match(pubd.url, /\/s\/nocturne-in-d-minor-[a-z0-9]{8}$/);
    assert.equal((await (await fetch(`${s.base}/api/shares/${pubd.slug}`)).json()).title, "Nocturne in D Minor");
    assert.equal((await (await fetch(`${s.base}/api/shares/${a1.slug.slice(-8)}`)).json()).slug, pubd.slug, "bare short id (legacy link) resolves to canonical");
    assert.ok((await (await fetch(`${s.base}/api/shares`)).json()).shares.some((x: { slug: string }) => x.slug === pubd.slug));
    // further auto-saves never un-publish nor rename a published song
    const a3 = await (await fetch(`${s.base}/api/songs/autosave`, { method: "PUT", headers: H(alice), body: JSON.stringify({ project: { ...c.project, name: "renamed locally", revision: 99 } }) })).json();
    assert.equal(a3.public, true); assert.equal(a3.title, "Nocturne in D Minor");
    // bob forks it: his auto-saved fork is private to him and records the parent
    const fork = new WorkstationController(); fork.loadShared(sanitizeSharedProject(anon.project)); fork.fork();
    const f = await (await fetch(`${s.base}/api/songs/autosave`, { method: "PUT", headers: H(bob), body: JSON.stringify({ project: fork.project, parentSlug: a1.slug }) })).json();
    assert.equal(f.public, false); assert.equal(f.owner, "bob"); assert.equal(f.parent.slug, pubd.slug);
    assert.equal((await fetch(`${s.base}/api/shares/${f.slug}`)).status, 404, "fork private to the forker");
    assert.equal((await fetch(`${s.base}/api/shares/${f.slug}`, { headers: H(alice) })).status, 404);
    assert.equal((await (await fetch(`${s.base}/api/shares/${a1.slug}`)).json()).forks, 0, "private forks are not counted publicly");
  } finally { await s.app.close(); }
});
