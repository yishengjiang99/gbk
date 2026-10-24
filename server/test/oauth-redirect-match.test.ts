// RFC 8252 §7.3 loopback redirect matching: port ignored for http loopback, everything else exact.
import test from "node:test";
import assert from "node:assert/strict";
import { redirectUriMatches as m } from "../src/mcp/oauth.ts";

test("Codex: registered portless loopback matches an ephemeral port", () => {
  assert.ok(m("http://127.0.0.1/callback", "http://127.0.0.1:52786/callback"));
  assert.ok(m("http://localhost/callback", "http://localhost:4000/callback"));
  assert.ok(m("http://[::1]/callback", "http://[::1]:9/callback"));
  assert.ok(m("http://127.0.0.1:1/cb?x=1", "http://127.0.0.1:2/cb?x=1"));
});

test("loopback: path, query, host and scheme must still match exactly", () => {
  assert.ok(!m("http://127.0.0.1/callback", "http://127.0.0.1:52786/other"));
  assert.ok(!m("http://127.0.0.1/callback", "http://127.0.0.1:52786/callback/"));
  assert.ok(!m("http://127.0.0.1/callback", "http://127.0.0.1:52786/callback?x=1"));
  assert.ok(!m("http://127.0.0.1/callback", "http://localhost:52786/callback"));
  assert.ok(!m("http://127.0.0.1/callback", "https://127.0.0.1:52786/callback"));
  assert.ok(!m("http://127.0.0.1/callback", "http://127.0.0.1:52786/callback#f"));
  assert.ok(!m("http://127.0.0.1/callback", "http://u@127.0.0.1:52786/callback"));
  assert.ok(!m("http://127.0.0.1/callback", "http://127.0.0.1.evil.com:52786/callback"));
});

test("non-loopback redirects stay exact (port matters)", () => {
  assert.ok(m("https://chatgpt.com/cb", "https://chatgpt.com/cb"));
  assert.ok(!m("https://chatgpt.com/cb", "https://chatgpt.com:8443/cb"));
  assert.ok(!m("http://example.com/cb", "http://example.com:81/cb"));
  assert.ok(!m("https://127.0.0.1/cb", "https://127.0.0.1:5/cb"));
});
