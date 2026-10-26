import test from "node:test";
import assert from "node:assert/strict";
import { friendlyError } from "../src/agent/friendly-error.ts";

test("composer errors are plain language: no codes, no internal ids", () => {
  for (const [c, m] of [["PROJECT_CHANGED", "the open project changed (expected prj_mvogs1d0i7kqa, now prj_mvoim2pc4id1s); re-read"], ["BROWSER_DISCONNECTED", "x"], ["WEIRD_CODE", "WEIRD_CODE: failed for prj_abcdefgh"], [undefined, ""]] as const) {
    const t = friendlyError(c, m); assert.doesNotMatch(t, /[A-Z]{3,}_[A-Z_]+|prj_[a-z0-9]+/, t); assert.ok(t.length > 3);
  }
});
