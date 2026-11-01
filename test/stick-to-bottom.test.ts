import test from "node:test";
import assert from "node:assert/strict";
import { isPinned, onGrow, PIN_PX } from "../src/components/studio/stick-to-bottom.ts";

test("pinned within 80px of the bottom", () => {
  assert.equal(PIN_PX, 80);
  assert.equal(isPinned({ scrollTop: 1000, clientHeight: 500, scrollHeight: 1500 }), true);
  assert.equal(isPinned({ scrollTop: 920, clientHeight: 500, scrollHeight: 1500 }), true);
  assert.equal(isPinned({ scrollTop: 919, clientHeight: 500, scrollHeight: 1500 }), false);
  assert.equal(isPinned({ scrollTop: 0, clientHeight: 500, scrollHeight: 1500 }), false);
});
test("nothing to scroll counts as pinned", () => {
  assert.equal(isPinned({ scrollTop: 0, clientHeight: 500, scrollHeight: 300 }), true);
});
test("growth scrolls only when pinned, otherwise flags new content", () => {
  assert.equal(onGrow(true), "scroll");
  assert.equal(onGrow(false), "flag");
});
test("custom threshold", () => {
  assert.equal(isPinned({ scrollTop: 900, clientHeight: 500, scrollHeight: 1500 }, 100), true);
});
