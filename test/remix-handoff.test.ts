import test from "node:test";
import assert from "node:assert/strict";
import { REMIX_KEY, setRemixHandoff, takeRemixHandoff } from "../src/agent/remix-handoff.ts";

// The module reads the sessionStorage global at call time; install an in-memory fake.
const store = new Map<string, string>();
(globalThis as { sessionStorage?: unknown }).sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
};

test("remix handoff round-trips slug + prompt and is consumed exactly once (#162)", () => {
  store.clear();
  setRemixHandoff({ slug: "symphony-no-5-in-c-minor-5gm8vhzs", prompt: "beethoven's fifth, dramatic" });
  assert.deepEqual(takeRemixHandoff(), { slug: "symphony-no-5-in-c-minor-5gm8vhzs", prompt: "beethoven's fifth, dramatic" });
  assert.equal(takeRemixHandoff(), null, "a second consumer gets nothing");
});

test("remix handoff caps the prompt at 4000 chars like the web card", () => {
  store.clear();
  setRemixHandoff({ slug: "some-song-abc123", prompt: "x".repeat(5000) });
  const h = takeRemixHandoff();
  assert.equal(h?.prompt.length, 4000);
});

test("remix handoff drops malformed payloads instead of throwing", () => {
  store.clear();
  store.set(REMIX_KEY, "{not json");
  assert.equal(takeRemixHandoff(), null);
  store.set(REMIX_KEY, JSON.stringify({ slug: "Bad Slug!", prompt: "x" }));
  assert.equal(takeRemixHandoff(), null, "a slug that is not a share slug is rejected");
  store.set(REMIX_KEY, JSON.stringify({ slug: "ok-slug-1" }));
  assert.deepEqual(takeRemixHandoff(), { slug: "ok-slug-1", prompt: "" }, "a missing prompt degrades to empty");
  assert.equal(takeRemixHandoff(), null, "absent key is null");
});
