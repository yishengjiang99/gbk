import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoute } from "../src/agent/routes.ts";

test("every song share URL form routes to that exact song", () => {
  const S = "maple-street-sunday-85f7n743";
  assert.deepEqual(parseRoute(`/s/${S}`, ""), { view: "feed", focus: S });
  assert.deepEqual(parseRoute(`/s/${S}`, "?fork=1"), { view: "share", slug: S, fork: true });
  assert.deepEqual(parseRoute(`/s/${S}`, "?edit=1"), { view: "share", slug: S, fork: false });
  assert.equal((parseRoute("/feed", `?pin=${S}`) as { focus?: string }).focus, S);
  for (const [p, q] of [[`/song/${S}`, ""], [`/share/${S}`, ""], ["/", `?s=${S}`]]) assert.deepEqual(parseRoute(p, q), { view: "feed", focus: S }, p + q);
  assert.deepEqual(parseRoute(`/share/${S}`, "?fork=1"), { view: "share", slug: S, fork: true });
  assert.deepEqual(parseRoute("/", "?s=%3Cx%3E"), { view: "feed", sort: undefined, label: undefined });
});
