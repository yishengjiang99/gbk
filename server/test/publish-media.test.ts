// #189: every published song has playable media. The iOS feed plays /media/midi; songs published via auto-save +
// PATCH {public:true} (web Publish dialog, iOS native publish) never uploaded any media, so they showed "no audio".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer, login } from "./ws-helpers.ts";
import { ShareStore } from "../src/persistence/shares.ts";
import { deriveMidi } from "../src/persistence/share-media.ts";

const project = JSON.parse(readFileSync(new URL("../../test/fixtures/social-song.json", import.meta.url), "utf8"));
const empty = { ...structuredClone(project), id: "prj_empty", notes: [] };
const H = (a: { cookie: string; csrf: string }) => ({ "content-type": "application/json", origin: "http://composer.test", "x-gbk-csrf": a.csrf, cookie: `${a.cookie}; gbk_csrf=${a.csrf}` });

test("#189 auto-save -> PATCH public: the published song serves a MIDI the app can play", async () => {
  const s = await startServer(new ScriptModel([() => reply("x")]));
  try {
    const a = await login(s.base, "code-a");
    const saved = await (await fetch(`${s.base}/api/songs/autosave`, { method: "PUT", headers: H(a), body: JSON.stringify({ project: { ...project, id: "prj_189" } }) })).json();
    assert.equal(saved.hasMidi, true, "auto-save stores a server-derived MIDI");
    const p = await fetch(`${s.base}/api/shares/${saved.slug}`, { method: "PATCH", headers: H(a), body: JSON.stringify({ public: true, title: "Die letzte Kompanie" }) });
    assert.equal(p.status, 200); const pub = await p.json(); assert.equal(pub.public, true); assert.equal(pub.hasMidi, true);
    const m = await fetch(`${s.base}/api/shares/${pub.slug}/media/midi`);
    assert.equal(m.status, 200); const bytes = new Uint8Array(await m.arrayBuffer());
    assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), "MThd");
  } finally { await s.app.close(); }
});

test("#189 publishing a song with no notes is refused with a clear error; it stays private", async () => {
  const s = await startServer(new ScriptModel([() => reply("x")]));
  try {
    const a = await login(s.base, "code-a");
    const post = await fetch(`${s.base}/api/shares`, { method: "POST", headers: H(a), body: JSON.stringify({ project: empty, public: true }) });
    assert.equal(post.status, 422); assert.equal((await post.json()).code, "NO_PLAYABLE_MEDIA");
    const saved = await (await fetch(`${s.base}/api/songs/autosave`, { method: "PUT", headers: H(a), body: JSON.stringify({ project: empty }) })).json();
    assert.equal(saved.hasMidi, false, "an empty private draft can still be saved");
    const p = await fetch(`${s.base}/api/shares/${saved.slug}`, { method: "PATCH", headers: H(a), body: JSON.stringify({ public: true, title: "Nothing" }) });
    assert.equal(p.status, 422); const err = await p.json(); assert.equal(err.code, "NO_PLAYABLE_MEDIA"); assert.match(err.message, /no notes/);
    assert.equal((await fetch(`${s.base}/api/shares/${saved.slug}`)).status, 404, "still private");
    assert.equal((await fetch(`${s.base}/api/shares/${saved.slug}`, { method: "PATCH", headers: H(a), body: '{"public":false}' })).status, 200, "unpublish never needs media");
  } finally { await s.app.close(); }
});

test("#189 ensurePlayable backfills MIDI for a legacy row, keeps uploaded media, refuses an empty song", () => {
  const st = new ShareStore(":memory:");
  const legacy = st.create({ owner: "u", title: "Legacy", projectJson: JSON.stringify(project), public: true });
  assert.equal(legacy.midi, null);
  assert.equal(st.ensurePlayable(legacy.slug), true);
  assert.deepEqual(st.media(legacy.id, "midi"), deriveMidi(JSON.stringify(project)));
  const up = st.create({ owner: "u", title: "Uploaded", projectJson: JSON.stringify(empty) });
  const mp3 = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]); st.setMedia(up.slug, "mp3", mp3);
  assert.equal(st.ensurePlayable(up.slug), true); assert.equal(st.media(up.id, "midi"), null, "existing audio is enough");
  const none = st.create({ owner: "u", title: "Empty", projectJson: JSON.stringify(empty) });
  assert.equal(st.ensurePlayable(none.slug), false); assert.equal(deriveMidi("{not json"), null);
});
