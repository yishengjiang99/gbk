// Crawlable server-rendered pages: /chatgpt, /privacy, /terms, /support, robots.txt, sitemap.xml.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer } from "./ws-helpers.ts";
import { STARTER_PROMPTS } from "../src/routes/pages.ts";

const plugin = JSON.parse(readFileSync(new URL("../../plugins/gbk-composer/plugin.json", import.meta.url), "utf8"));
const ui = plugin.extensions["com.openai"].interface;

test("static pages render with SEO tags, footer links and normal scrolling", async () => {
  const s = await startServer(new ScriptModel([() => reply("x")]));
  try {
    for (const p of ["/chatgpt", "/privacy", "/terms", "/support"]) {
      const r = await fetch(`${s.base}${p}`); assert.equal(r.status, 200, p);
      assert.match(r.headers.get("content-type") ?? "", /text\/html/);
      const h = await r.text();
      assert.match(h, /<title>[^<]+<\/title>/); assert.match(h, /<meta name="description"/);
      assert.match(h, new RegExp(`<link rel="canonical" href="[^"]+${p}"`)); assert.match(h, /og:title/); assert.match(h, /twitter:card/);
      for (const l of ["/privacy", "/terms", "/support", "/chatgpt"]) assert.ok(h.includes(`href="${l}"`), `${p} footer links ${l}`);
      assert.doesNotMatch(h, /overflow(-y)?:\s*hidden/);
    }
    const c = await (await fetch(`${s.base}/chatgpt`)).text();
    assert.match(c, /application\/ld\+json/); assert.match(c, /coming soon/); assert.doesNotMatch(c, /Install in ChatGPT/);
    assert.match(c, /never synthesize audio/);
    for (const p of STARTER_PROMPTS) assert.ok(c.includes(p.replace(/'/g, "&#39;")), p);
    const robots = await (await fetch(`${s.base}/robots.txt`)).text(); assert.match(robots, /Sitemap: .*\/sitemap\.xml/);
    const sm = await (await fetch(`${s.base}/sitemap.xml`)).text();
    for (const p of ["/chatgpt", "/privacy", "/terms", "/support"]) assert.ok(sm.includes(`${p}</loc>`), p);
  } finally { await s.app.close(); }
});

test("install button appears only when CHATGPT_PLUGIN_URL is set", async () => {
  const s = await startServer(new ScriptModel([() => reply("x")]), { CHATGPT_PLUGIN_URL: "https://chatgpt.com/apps/gbk" });
  try { assert.match(await (await fetch(`${s.base}/chatgpt`)).text(), /href="https:\/\/chatgpt.com\/apps\/gbk"[^>]*>Install in ChatGPT/); }
  finally { await s.app.close(); }
});

test("plugin.json references the icon, listing URLs, and starter prompts match the landing page", () => {
  assert.deepEqual(ui.defaultPrompt, STARTER_PROMPTS);
  for (const k of ["logo", "composerIcon"]) {
    assert.match(ui[k], /^\.\//);
    const f = new URL(`../../plugins/gbk-composer/${ui[k].slice(2)}`, import.meta.url); assert.ok(existsSync(f), k);
    const png = readFileSync(f); assert.equal(png.readUInt32BE(16), 512); assert.equal(png.readUInt32BE(20), 512);
  }
  for (const k of ["privacyPolicyURL", "termsOfServiceURL", "supportURL", "websiteURL"]) assert.match(ui[k], /^https:\/\/compose\.grepawk\.com\//);
});
