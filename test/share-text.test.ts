import test from "node:test";
import assert from "node:assert/strict";
import { songAuthorCredit, songOgTitle, songShareFields, songShareLine, songShareText, songTitleOf, storedXHandle, xIntentUrl } from "../src/agent/share-text.ts";

test("title falls back to Untitled and strips surrounding space", () => {
  assert.equal(songTitleOf(null), "Untitled");
  assert.equal(songTitleOf(""), "Untitled");
  assert.equal(songTitleOf("  "), "Untitled");
  assert.equal(songTitleOf(" Night Drive "), "Night Drive");
});

test("share line is quoted title by @handle; inner quotes become singles", () => {
  assert.equal(songShareLine({ title: `Night "Drive"`, handle: "alice" }), `"Night 'Drive'" by @alice`);
  assert.equal(songShareLine({ title: "Minuet in G", handle: "@yisheng" }), `"Minuet in G" by @yisheng`);
});

test("missing author omits the by-clause; missing title is Untitled", () => {
  assert.equal(songShareLine({ title: "Solo" }), `"Solo"`);
  assert.equal(songShareLine({}), `"Untitled"`);
  assert.equal(songShareLine({ title: "", displayName: "Alice" }), `"Untitled" by Alice`);
});

test("X uses a stored X handle only when valid; otherwise the gbk handle", () => {
  assert.equal(storedXHandle(null), null);
  assert.equal(storedXHandle(""), null);
  assert.equal(storedXHandle("not a handle!!"), null);
  assert.equal(storedXHandle("@GoodHandle"), "GoodHandle");
  assert.equal(songAuthorCredit({ handle: "alice", xHandle: "alice_x" }, { forX: true }), "@alice_x");
  assert.equal(songAuthorCredit({ handle: "alice", xHandle: "nope!!" }, { forX: true }), "@alice");
  assert.equal(songAuthorCredit({ handle: "alice", xHandle: "alice_x" }), "@alice");
  assert.equal(songShareLine({ title: "Song", handle: "alice", xHandle: "alice_x" }, { forX: true }), `"Song" by @alice_x`);
});

test("share text and X intent include the title, author, and URL-encoded link", () => {
  const s = { title: "Minuet in G", handle: "yisheng", url: "https://compose.grepawk.com/s/minuet-in-g-a1b2c3" };
  assert.equal(songShareText(s), `"Minuet in G" by @yisheng\nhttps://compose.grepawk.com/s/minuet-in-g-a1b2c3`);
  assert.equal(songOgTitle(s), `"Minuet in G" by @yisheng`);
  const intent = xIntentUrl(songShareText(s, { forX: true }));
  assert.ok(intent.startsWith("https://x.com/intent/tweet?text="));
  const text = decodeURIComponent(new URL(intent).searchParams.get("text")!);
  assert.equal(text, songShareText(s));
  const f = songShareFields(s);
  assert.equal(f.share_title, `"Minuet in G" by @yisheng`);
  assert.equal(f.share_text, songShareText(s));
  assert.equal(f.x_intent_url, intent);
});
