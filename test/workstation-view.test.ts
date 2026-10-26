import test from "node:test";
import assert from "node:assert/strict";
import { resolveCompactStudioMode } from "../src/components/workstation/compact-studio.ts";

test("composer mode forces the compact studio contract", () => {
  assert.equal(resolveCompactStudioMode({ composer: true, narrow: false, inApp: false }), true);
  assert.equal(resolveCompactStudioMode({ composer: false, narrow: false, inApp: false }), false);
});

test("compact mode still follows the mobile/native fallbacks", () => {
  assert.equal(resolveCompactStudioMode({ composer: false, narrow: true, inApp: false }), true);
  assert.equal(resolveCompactStudioMode({ composer: false, narrow: false, inApp: true }), true);
});
