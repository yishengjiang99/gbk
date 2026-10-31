import test from "node:test";
import assert from "node:assert/strict";
import { autoGrowTextarea, COMPOSER_MAX_HEIGHT_PX } from "../src/components/studio/studio-logic.ts";

// The studios drive autoGrowTextarea from an effect on the text state; here the sizing rules are
// pinned with a fake element (scrollHeight stands in for the laid-out content height).
const fake = (scrollHeight: number) => ({ scrollHeight, style: { height: "", overflowY: "" } });

test("composer auto-grow: short text pins to its content height, no internal scroll", () => {
  const el = fake(44);
  autoGrowTextarea(el);
  assert.equal(el.style.height, "44px");
  assert.equal(el.style.overflowY, "hidden");
});

test("composer auto-grow: multi-line text stretches past one row", () => {
  const el = fake(132);
  autoGrowTextarea(el);
  assert.equal(el.style.height, "132px");
  assert.equal(el.style.overflowY, "hidden");
});

test("composer auto-grow: very long text caps at the max and scrolls internally", () => {
  const el = fake(640);
  autoGrowTextarea(el);
  assert.equal(el.style.height, `${COMPOSER_MAX_HEIGHT_PX}px`);
  assert.equal(el.style.overflowY, "auto");
});

test("composer auto-grow: a missing element is a no-op", () => {
  assert.doesNotThrow(() => autoGrowTextarea(null));
});
