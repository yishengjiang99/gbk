// GeneralUser-GS download retry (telemetry audit: 29 SoundFont fetch failures): transient failures retry with
// backoff; aborts and non-transient HTTP errors fail at once.
import test from "node:test";
import assert from "node:assert/strict";
import { fetchSoundFontBytes } from "../src/audio/sf2-fetch.ts";

const URL_ = "http://x/static/test-font.sf2";
const ok = (n = 4) => new Response(new Uint8Array(n).fill(7));
function script(...steps: (() => Response | Promise<Response>)[]) {
  let i = 0; const calls: number[] = [];
  const f = (async () => { calls.push(i); const s = steps[Math.min(i++, steps.length - 1)]; return s(); }) as unknown as typeof fetch;
  return { f, calls };
}

test("retries network errors and 5xx/429, then succeeds", async () => {
  const s = script(() => { throw new TypeError("network down"); }, () => new Response("busy", { status: 503 }), () => ok());
  const waits: number[] = [];
  const bytes = await fetchSoundFontBytes(URL_, { fetchImpl: s.f, backoffMs: (n) => { waits.push(n); return 0; } });
  assert.equal(bytes.length, 4); assert.equal(s.calls.length, 3); assert.deepEqual(waits, [1, 2]);
});

test("gives up after `attempts` and rethrows the last error; default backoff grows", async () => {
  const s = script(() => new Response("x", { status: 502 }));
  await assert.rejects(fetchSoundFontBytes(URL_, { fetchImpl: s.f, attempts: 3, backoffMs: () => 0 }), (e: { status?: number }) => e.status === 502);
  assert.equal(s.calls.length, 3);
  const t0 = Date.now(); const s2 = script(() => { throw new TypeError("down"); }, () => ok());
  await fetchSoundFontBytes(URL_, { fetchImpl: s2.f }); assert.ok(Date.now() - t0 >= 450, "first default backoff is ~500 ms");
});

test("404 and aborts are not retried", async () => {
  const s = script(() => new Response("no", { status: 404 }), () => ok());
  await assert.rejects(fetchSoundFontBytes(URL_, { fetchImpl: s.f, backoffMs: () => 0 }), (e: { status?: number }) => e.status === 404);
  assert.equal(s.calls.length, 1);
  const ctl = new AbortController();
  const s2 = script(() => { ctl.abort(); throw Object.assign(new Error("aborted"), { name: "AbortError" }); }, () => ok());
  await assert.rejects(fetchSoundFontBytes(URL_, { fetchImpl: s2.f, signal: ctl.signal, backoffMs: () => 0 }));
  assert.equal(s2.calls.length, 1);
  // abort during the backoff wait stops the retry loop
  const ctl3 = new AbortController(); const s3 = script(() => { throw new TypeError("down"); }, () => ok());
  const p = fetchSoundFontBytes(URL_, { fetchImpl: s3.f, signal: ctl3.signal, backoffMs: () => 10_000 });
  setTimeout(() => ctl3.abort(), 20);
  await assert.rejects(p, (e: Error) => e.name === "AbortError"); assert.equal(s3.calls.length, 1);
});

test("a download cut short of the catalog size is retried, never returned as a stub", async () => {
  const s = script(() => ok(1024));
  await assert.rejects(fetchSoundFontBytes("http://x/static/GeneralUser-GS.sf2", { fetchImpl: s.f, backoffMs: () => 0 }), /truncated/);
  assert.equal(s.calls.length, 3);
});
