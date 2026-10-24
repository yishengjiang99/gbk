import test from "node:test";
import assert from "node:assert/strict";
import { ErrorReporter, cleanUrl, scrub, reportError } from "../src/telemetry/error-reporter.ts";

const mk = (o: Partial<ConstructorParameters<typeof ErrorReporter>[0]> = {}) => {
  const sent: { url: string; body: any; unloading: boolean }[] = []; let t = 1_000_000;
  const r = new ErrorReporter({ endpoint: "/api/client-errors", flushMs: 10_000, now: () => t, send: (url, body, unloading) => sent.push({ url, body: JSON.parse(body), unloading }), ...o });
  return { r, sent, tick: (ms: number) => { t += ms; } };
};

test("error reporter: dedupes repeats into one entry with a count and flushes a batch", () => {
  const { r, sent } = mk();
  for (let i = 0; i < 5; i++) r.capture("report", new Error("same"), { where: "render-job" });
  r.capture("error", new TypeError("other"));
  r.breadcrumb("nav /s/x");
  r.flush(true);
  assert.equal(sent.length, 1); assert.equal(sent[0].url, "/api/client-errors"); assert.equal(sent[0].unloading, true);
  const [a, b] = sent[0].body.errors;
  assert.equal(a.count, 5); assert.equal(a.message, "same"); assert.deepEqual(a.context, { where: "render-job" }); assert.match(a.stack, /error-reporter\.test/);
  assert.equal(b.message, "TypeError: other"); assert.equal(typeof a.release, "string"); assert.equal(typeof a.ts, "number");
});

test("error reporter: client-side rate limit per minute and per page; batch size triggers flush", () => {
  const { r, sent, tick } = mk({ maxPerMinute: 3, maxPerPage: 5, maxBatch: 100 });
  for (let i = 0; i < 10; i++) r.capture("console", `e${i}`);
  r.flush(false); assert.equal(sent[0].body.errors.length, 3);
  tick(61_000); for (let i = 0; i < 10; i++) r.capture("console", `f${i}`);
  r.flush(false); assert.equal(sent[1].body.errors.length, 2, "page cap of 5 total");
  const b = mk({ maxBatch: 2 }); b.r.capture("report", "x1"); b.r.capture("report", "x2");
  assert.equal(b.sent.length, 1, "flushes immediately at maxBatch");
});

test("error reporter: scrubs credentials and strips query strings; reportError is a no-op before install", () => {
  assert.equal(cleanUrl("https://compose.grepawk.com/studio?code=abc&state=x#t"), "https://compose.grepawk.com/studio");
  const s = scrub("Authorization: Bearer abcdef0123456789 and ?access_token=xyz123&ok=1 sk-abcdefghijklmnopqr");
  assert.doesNotMatch(s, /abcdef0123456789|xyz123|sk-abcdefghijklmnopqr/);
  const { r, sent } = mk(); r.capture("report", { message: "with token=SECRETVALUE" }); r.flush(false);
  assert.doesNotMatch(JSON.stringify(sent), /SECRETVALUE/);
  assert.doesNotThrow(() => reportError(new Error("not installed")));
});

test("error reporter: never recurses or throws when send fails", () => {
  const r = new ErrorReporter({ send: () => { throw new Error("network"); }, maxBatch: 1 });
  assert.doesNotThrow(() => r.capture("report", new Error("x")));
});
