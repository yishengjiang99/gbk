// Discovery eval fixtures are well-formed and reference real tools; scoring is correct.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { summarize, scoreOne, type Fixture } from "../scripts/plugin-discovery/score.ts";

const dir = new URL("./fixtures/plugin-discovery/", import.meta.url);
const fixtures: Fixture[] = readdirSync(dir).filter((f) => f.endsWith(".json")).flatMap((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")).fixtures);
const serverSrc = readFileSync(new URL("../server/src/mcp/server.ts", import.meta.url), "utf8");
const toolNames = new Set([...serverSrc.matchAll(/registerTool\("([a-z_]+)"/g)].map((m) => m[1]));

test("at least 40 fixtures across categories A-D with unique ids and real expected tools", () => {
  assert.ok(fixtures.length >= 40, `${fixtures.length}`);
  assert.equal(new Set(fixtures.map((f) => f.id)).size, fixtures.length);
  for (const c of ["A", "B", "C", "D"]) assert.ok(fixtures.filter((f) => f.category === c).length >= 8, c);
  for (const f of fixtures) {
    assert.ok(["tool", "no_tool", "either"].includes(f.expect), f.id);
    if (f.expect === "no_tool") assert.equal(f.expectedFirstTool, null, f.id);
    else for (const t of f.expectedFirstTool ?? []) assert.ok(toolNames.has(t), `${f.id}: ${t} is not a registered tool`);
  }
});

test("scoring: invocation, first tool, negatives and borderline", () => {
  const f = (id: string, category: Fixture["category"], expect: Fixture["expect"], first: string[] | null): Fixture => ({ id, category, expect, expectedFirstTool: first, prompt: "p" });
  const fx = [f("a", "A", "tool", ["gbk_create_composition"]), f("b", "A", "tool", ["gbk_create_composition"]), f("c", "C", "no_tool", null), f("d", "D", "either", null)];
  const s = summarize(fx, [{ id: "a", firstTool: "gbk_create_composition" }, { id: "b", firstTool: "gbk_get_capabilities" }, { id: "c", firstTool: "gbk_create_composition" }, { id: "d", firstTool: null }]);
  assert.deepEqual(s.recall, { correct: 2, total: 2, rate: 1 });
  assert.deepEqual(s.firstToolAccuracy, { correct: 1, total: 2, rate: 0.5 });
  assert.equal(s.falsePositiveRate, 1);
  assert.equal(s.borderline.invokedGbk, 0);
  assert.equal(scoreOne(fx[0], { id: "a", firstTool: null, error: "HTTP 500" }).invocationCorrect, null, "errors are not scored as misses");
  assert.equal(scoreOne(fx[0], { id: "a", firstTool: "web_search" }).invocationCorrect, false);
});
