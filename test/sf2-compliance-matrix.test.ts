// Keeps docs/SF2_COMPLIANCE.md honest: every row names tests that exist, and every row is pass or n/a (reason).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

test("testComplianceMatrixIsCovered", () => {
  const rows = readFileSync("docs/SF2_COMPLIANCE.md", "utf8").split("\n").flatMap((line) => {
    const c = line.split("|").map((s) => s.trim());
    if (c.length < 7 || !/^[A-Z]+-\d+$/.test(c[1])) return [];
    return [{ id: c[1], tests: c[4] === "—" ? [] : c[4].split(",").map((s) => s.trim()), status: c[5] }];
  });
  assert.ok(rows.length > 80, `${rows.length} rows`);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, "duplicate IDs");
  const names = new Set<string>();
  for (const f of readdirSync("test").filter((f) => f.endsWith(".test.ts"))) {
    for (const m of readFileSync(`test/${f}`, "utf8").matchAll(/\btest\(\s*"(\w+)"/g)) names.add(m[1]);
  }
  let pass = 0, na = 0;
  for (const r of rows) {
    const isNa = r.status.startsWith("n/a (") && r.status.endsWith(")");
    assert.ok(r.status === "pass" || isNa, `${r.id}: bad status '${r.status}'`);
    if (isNa) na++; else { pass++; assert.ok(r.tests.length > 0, `${r.id}: no test named`); }
    for (const t of r.tests) assert.ok(names.has(t), `${r.id}: test ${t} does not exist`);
  }
  assert.deepEqual({ pass, na }, { pass: 80, na: 3 });
});
