import { test } from "node:test";
import assert from "node:assert/strict";
import { originTrialTokens } from "../vite.config.ts";

test("origin-trial tokens come from env, are split and sanitized, and default to none", () => {
  assert.deepEqual(originTrialTokens({}, "/nonexistent.json"), []);
  assert.deepEqual(originTrialTokens({ GBK_WEBMCP_ORIGIN_TRIAL_TOKEN: " AbC+/= , Def== " }, "/nonexistent.json"), ["AbC+/=", "Def=="]);
  assert.deepEqual(originTrialTokens({ GBK_WEBMCP_ORIGIN_TRIAL_TOKEN: '"><script>' }, "/nonexistent.json"), []);
});
