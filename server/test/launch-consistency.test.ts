// Launch reconciliation (#72): the implementation is the source of truth. Docs, the plugin
// package and the legal pages must list the registered tools and must not contradict the code.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const registry = [...read("server/src/mcp/server.ts").matchAll(/registerTool\("(gbk_[a-z_]+)"/g)].map((m) => m[1]).sort();

test("registry is the expected 17 tools", () => {
  assert.equal(new Set(registry).size, registry.length);
  assert.equal(registry.length, 17, registry.join(","));
});

test("plugin README, MCP doc and submission packet name every registered tool and no unknown MCP tool", () => {
  for (const f of ["plugins/gbk-composer/README.md", "docs/chatgpt-plugin.md", "docs/chatgpt-plugin-submission.md"]) {
    const s = read(f);
    for (const t of registry) assert.ok(s.includes(t), `${f} is missing ${t}`);
    const named = new Set([...s.matchAll(/`(gbk_[a-z_]+)`/g)].map((m) => m[1]));
    for (const n of named) assert.ok(registry.includes(n) || n === "gbk_composer" || n === "gbk_mcp_render_job", `${f} names unknown tool ${n}`);
  }
});

test("plugin skills and manifest only reference registered tools", () => {
  const dir = "plugins/gbk-composer/skills";
  const texts = readdirSync(new URL(`../../${dir}`, import.meta.url)).map((d) => read(`${dir}/${d}/SKILL.md`));
  texts.push(read("plugins/gbk-composer/plugin.json"));
  for (const s of texts) for (const m of s.matchAll(/\b(gbk_[a-z_]+)\b/g)) assert.ok(registry.includes(m[1]) || m[1] === "gbk_composer", m[1]);
});

test("no stale contradictions: status, delete, claim, browser-only rendering", () => {
  const sub = read("docs/chatgpt-plugin-submission.md");
  assert.doesNotMatch(sub, /There is no delete tool/);
  assert.match(sub, /UPLOADED only/);
  assert.doesNotMatch(sub, /(plugin|GBK Composer|listing) (is|has been) (approved|published|listed)/i);
  const pages = read("server/src/routes/pages.ts");
  assert.doesNotMatch(pages, /cannot move such a composition to an account\./);
  assert.doesNotMatch(pages, /rendering runs in your browser\./);
  assert.doesNotMatch(read("docs/compose-deploy.md"), /server never holds audio/);
  assert.doesNotMatch(read("plugins/gbk-composer/README.md"), /Render WAV in the user's browser \(Studio tab or in-chat player\)/);
  const create = read("server/src/mcp/server.ts").match(/title: "Create a composition", description: "([^"]+)"/)![1];
  assert.match(create, /GBK server/);
});
