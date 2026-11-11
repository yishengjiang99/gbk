import test from "node:test";
import assert from "node:assert/strict";

// impressions.ts reads these at import time.
const store: Record<string, string> = {};
Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } },
});
Object.defineProperty(globalThis, "location", { configurable: true, value: { search: "", origin: "https://compose.grepawk.com" } });

const shares: Array<ShareData & { keys: string[] }> = [];
const clips: string[] = [];
const nav: { share?: (d: ShareData) => Promise<void>; clipboard: { writeText: (t: string) => Promise<void> } } = {
  share: async (d: ShareData) => { shares.push({ ...d, keys: Object.keys(d) }); },
  clipboard: { writeText: async (t: string) => { clips.push(t); } },
};
Object.defineProperty(globalThis, "navigator", { configurable: true, value: nav });

const { sharePayload, webShare, copyShare } = await import("../src/components/social/share-song.ts");

const song = { title: "Minuet in G", handle: "yisheng", url: "https://compose.grepawk.com/s/minuet-in-g-a1b2c3" };
const expected = `"Minuet in G" by @yisheng\nhttps://compose.grepawk.com/s/minuet-in-g-a1b2c3`;

test("share payload text is title, @handle, and URL", () => {
  const p = sharePayload(song);
  assert.equal(p.line, `"Minuet in G" by @yisheng`);
  assert.equal(p.text, expected);
  assert.ok(p.text.includes("@yisheng"));
  assert.ok(p.text.includes(song.url));
});

test("webShare passes only text (no separate url) so iOS keeps the title and author", async () => {
  shares.length = 0;
  webShare(song);
  await Promise.resolve();
  assert.equal(shares.length, 1);
  assert.equal(shares[0].text, expected);
  assert.ok(shares[0].text!.includes("Minuet in G"));
  assert.ok(shares[0].text!.includes("@yisheng"));
  assert.ok(shares[0].text!.includes(song.url));
  assert.equal(shares[0].url, undefined);
  assert.equal(shares[0].title, undefined);
  assert.deepEqual(shares[0].keys, ["text"]);
});

test("webShare falls back to the clipboard with the same text", async () => {
  const prev = nav.share;
  delete nav.share;
  clips.length = 0;
  webShare(song);
  await Promise.resolve();
  assert.deepEqual(clips, [expected]);
  nav.share = prev;
});

test("copyShare writes the full share text", async () => {
  clips.length = 0;
  copyShare(song);
  await Promise.resolve();
  assert.deepEqual(clips, [expected]);
});
