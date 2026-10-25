import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer } from "./ws-helpers.ts";
import { provisionArtist, revokeArtist } from "../src/cli/artist.ts";
import { SocialStore } from "../src/persistence/social.ts";
import { NativeStore } from "../src/persistence/native.ts";

const project = JSON.parse(readFileSync(new URL("../../test/fixtures/social-song.json", import.meta.url), "utf8"));
test("AI artist: provision with badge + bio, bearer publish with labels/tags, revoke kills the token", async () => {
  const s = await startServer(new ScriptModel([() => reply("x")]));
  try {
    const st = { sessions: s.sessions, accounts: s.accounts, social: new SocialStore(s.shares.database), native: new NativeStore(":memory:") };
    assert.throws(() => provisionArtist(st, { handle: "randomguy", name: "X", bio: "" }), /handle must be one of/);
    const { token } = provisionArtist(st, { handle: "lofiluna", name: "Lofi Luna", bio: "lo-fi / chillhop" });
    const u = await (await fetch(`${s.base}/api/users/lofiluna`)).json();
    assert.equal(u.user.badge, "AI artist"); assert.equal(u.user.bio, "lo-fi / chillhop"); assert.equal(u.user.display_name, "Lofi Luna");
    const A = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const sh = await (await fetch(`${s.base}/api/shares`, { method: "POST", headers: A, body: JSON.stringify({ title: "Rainy Window", project, public: true }) })).json();
    const m = await (await fetch(`${s.base}/api/songs/${sh.slug}/meta`, { method: "PATCH", headers: A, body: JSON.stringify({ labels: ["lofi"], tags: ["chillhop", "rain"], prompt_shared: true, prompt_text: "mellow lofi beat with rain" }) })).json();
    assert.deepEqual(m.labels, ["lofi"]); assert.equal(m.author.badge, "AI artist"); assert.equal(m.prompt_text, "mellow lofi beat with rain");
    // re-provision rotates: old token dies
    const { token: t2 } = provisionArtist(st, { handle: "lofiluna", name: "Lofi Luna", bio: "lo-fi / chillhop" });
    assert.equal((await fetch(`${s.base}/api/me`, { headers: A })).status, 401);
    assert.equal((await fetch(`${s.base}/api/me`, { headers: { authorization: `Bearer ${t2}` } })).status, 200);
    revokeArtist(st, "lofiluna");
    assert.equal((await fetch(`${s.base}/api/me`, { headers: { authorization: `Bearer ${t2}` } })).status, 401);
  } finally { await s.app.close(); }
});
