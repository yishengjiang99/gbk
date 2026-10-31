import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerSettings, ProStatus, PRO_MANAGE_HREF } from "../src/components/composer/ComposerSettings.tsx";

const base = { info: null, model: "m", setModel: () => {}, usage: null, user: "Yisheng", onLogout: () => {}, onReset: () => {} };

test("Pro users get the badge and 'Pro · manage' linking to /plans", () => {
  const html = renderToStaticMarkup(createElement(ComposerSettings, { ...base, pro: true }));
  assert.match(html, /data-testid="settings-pro"[^>]*>Pro</);
  assert.match(html, new RegExp(`href="${PRO_MANAGE_HREF}"[^>]*data-testid="pro-manage"[^>]*>Pro · manage<`));
  assert.equal(PRO_MANAGE_HREF, "/plans");
});

test("Free users see no Pro badge or manage link", () => {
  const html = renderToStaticMarkup(createElement(ComposerSettings, { ...base, pro: false }));
  assert.doesNotMatch(html, /settings-pro|pro-manage/);
  assert.equal(renderToStaticMarkup(createElement(ProStatus, { pro: false })), "");
});
