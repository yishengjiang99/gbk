// Server-rendered static pages: /support must offer a private billing channel next to public GitHub issues.
import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { pageRoutes, SUPPORT_EMAIL } from "../src/routes/pages.ts";
import type { Config } from "../src/config.ts";

async function setup() {
  const app = Fastify();
  pageRoutes(app, { publicOrigin: "https://compose.test" } as Config);
  await app.ready();
  return app;
}

test("/terms carries the Pro billing and refund policy (#125)", async () => {
  const app = await setup();
  try {
    const r = await app.inject("/terms");
    assert.equal(r.statusCode, 200);
    assert.match(r.body, /Pro plans, billing and refunds/);
    assert.match(r.body, /renew automatically/);
    assert.match(r.body, /7-day free trial/);
    assert.match(r.body, /within 14 days/);
    assert.match(r.body, /lifetime purchases are refundable in full within 30 days/);
    assert.match(r.body, /reportaproblem\.apple\.com/);
    assert.doesNotMatch(r.body, /a free, experimental music-composition tool/);
  } finally { await app.close(); }
});

test("/support lists the private billing email alongside the public GitHub channel", async () => {
  const app = await setup();
  try {
    const r = await app.inject("/support");
    assert.equal(r.statusCode, 200);
    assert.equal(SUPPORT_EMAIL, "yisheng.jiang@gmail.com");
    assert.ok(r.body.includes(`href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>`), "mailto link with the address as its label");
    assert.match(r.body, /Billing and Pro support \(private\)/);
    assert.match(r.body, /billing, refunds, receipts or subscription help/i);
    assert.match(r.body, /within two business days/);
    assert.match(r.body, /Never send card details/);
    assert.match(r.body, /will never ask for your card number/);
    assert.match(r.body, /Open a GitHub issue/);
  } finally { await app.close(); }
});
