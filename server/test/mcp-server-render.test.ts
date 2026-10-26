// Headless server rendering: an MCP client with no browser (guest or signed-in, no Studio tab) gets a validated
// WAV and a Standard MIDI File as signed download URLs, rendered by the app's own SF2 engine in a worker thread.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer } from "./ws-helpers.ts";
import { McpClient } from "./mcp-helpers.ts";
import { entitlementFetch } from "./stripe-helpers.ts";

const model = () => new ScriptModel([() => reply("unused")]);
const errorCode = (code: string) => (e: unknown) => JSON.stringify(e).includes(code) || String((e as Error)?.message ?? "").includes(code);
interface Art { kind: string; downloadUrl: string; sha256: string; sizeBytes: number; mimeType: string; meta: Record<string, unknown> }
interface Job { status: string; jobId: string; renderedOn?: string; artifacts: Art[]; config: { executor: string }; error: unknown }

export function parseWav(b: Buffer) {
  assert.equal(b.toString("ascii", 0, 4), "RIFF"); assert.equal(b.toString("ascii", 8, 12), "WAVE");
  let p = 12; let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null; let dataBytes = -1;
  while (p + 8 <= b.length) {
    const id = b.toString("ascii", p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === "fmt ") fmt = { format: b.readUInt16LE(p + 8), channels: b.readUInt16LE(p + 10), sampleRate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === "data") { dataBytes = size; break; }
    p += 8 + size + (size & 1);
  }
  assert.ok(fmt && dataBytes > 0, "fmt + data chunks");
  return { ...fmt!, dataBytes, seconds: dataBytes / (fmt!.sampleRate * fmt!.channels * (fmt!.bits / 8)) };
}

export function parseMidi(b: Buffer) {
  assert.equal(b.toString("ascii", 0, 4), "MThd"); assert.equal(b.readUInt32BE(4), 6);
  const format = b.readUInt16BE(8), ntrks = b.readUInt16BE(10), division = b.readUInt16BE(12);
  let p = 14, chunks = 0; const tempos: number[] = [];
  while (p + 8 <= b.length) {
    assert.equal(b.toString("ascii", p, p + 4), "MTrk"); const len = b.readUInt32BE(p + 4);
    const body = b.subarray(p + 8, p + 8 + len);
    for (let i = 0; i + 5 < body.length; i++) if (body[i] === 0xff && body[i + 1] === 0x51 && body[i + 2] === 0x03) tempos.push(60_000_000 / ((body[i + 3] << 16) | (body[i + 4] << 8) | body[i + 5]));
    chunks++; p += 8 + len;
  }
  assert.equal(p, b.length, "no trailing bytes");
  return { format, ntrks, division, chunks, tempos };
}

const get = async (base: string, url: string) => { const u = new URL(url); const r = await fetch(base + u.pathname + u.search); assert.equal(r.status, 200); return Buffer.from(await r.arrayBuffer()); };

test("guest with no browser: render returns server-rendered WAV (44.1k stereo PCM16) + valid MIDI as URLs", { timeout: 120_000 }, async () => {
  const s = await startServer(model());
  try {
    const c = new McpClient(s.base); await c.initialize();
    const g = await c.call<{ compositionId: string; accessToken: string }>("gbk_create_composition", { title: "Server render", style: "classical", bars: 2, tempo: 120, seed: 3 });
    const comp = await c.call<{ tracks?: unknown[]; structure?: { tracks?: unknown[] } }>("gbk_get_composition", { compositionId: g.compositionId, accessToken: g.accessToken });
    const trackCount = (comp.tracks ?? comp.structure?.tracks ?? []).length;
    const r = await c.call<Job>("gbk_render_composition", { compositionId: g.compositionId, accessToken: g.accessToken, waitSeconds: 110 });
    assert.equal(r.status, "completed", JSON.stringify(r.error));
    assert.equal(r.renderedOn, "server"); assert.equal(r.config.executor, "server");
    assert.deepEqual(r.artifacts.map((a) => a.kind).sort(), ["midi", "wav"], "server renders always publish WAV and MIDI");
    assert.ok(!JSON.stringify(r).includes("UklGR"), "no WAV bytes in the tool result");
    assert.ok(JSON.stringify(r).length < 20_000, "tool result stays small (URLs + metadata only)");

    const wavArt = r.artifacts.find((a) => a.kind === "wav")!;
    const wav = await get(s.base, wavArt.downloadUrl);
    assert.equal(wav.length, wavArt.sizeBytes); assert.equal(createHash("sha256").update(wav).digest("hex"), wavArt.sha256);
    const w = parseWav(wav);
    assert.deepEqual([w.format, w.channels, w.sampleRate, w.bits], [1, 2, 44100, 16]);
    // 2 bars of 4/4 at 120 bpm = 4 s of music + 3 s tail
    assert.ok(w.seconds > 5 && w.seconds < 9, `duration ${w.seconds}`);
    let peak = 0; for (let i = 44; i + 1 < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
    assert.ok(peak > 1000, "audible");

    const midArt = r.artifacts.find((a) => a.kind === "midi")!;
    const mid = await get(s.base, midArt.downloadUrl);
    assert.equal(createHash("sha256").update(mid).digest("hex"), midArt.sha256);
    const m = parseMidi(mid);
    assert.equal(m.format, 1); assert.equal(m.chunks, m.ntrks, "MTrk count matches header");
    if (trackCount) assert.equal(m.ntrks, trackCount + 1, "conductor track + one per project track");
    assert.ok(m.ntrks >= 2);
    assert.ok(m.tempos.length >= 1 && Math.abs(m.tempos[0] - 120) < 0.01, `tempo ${m.tempos}`);

    // Rate limit: one in flight / per-hour cap (set below) - a second immediate render is still allowed here (default 6/h).
    const again = await c.call<Job>("gbk_render_composition", { compositionId: g.compositionId, accessToken: g.accessToken, waitSeconds: 0 });
    assert.ok(["running", "queued", "completed"].includes(again.status));
    await assert.rejects(c.call("gbk_render_composition", { compositionId: g.compositionId, accessToken: g.accessToken, waitSeconds: 0 }), errorCode("QUOTA_EXCEEDED"), "one server render in flight per project");
    await c.call("gbk_get_render_status", { jobId: again.jobId, accessToken: g.accessToken, waitSeconds: 100 });
  } finally { await s.app.close(); }
});

test("signed-in client with no Studio tab renders on the server; limits: duration and hourly rate", { timeout: 120_000 }, async () => {
  const s = await startServer(model(), { MCP_TEST_AUTH: "1", SERVER_RENDER_ACCOUNT_PER_HOUR: "1", SERVER_RENDER_ACCOUNT_MAX_SECONDS: "20" });
  try {
    const c = new McpClient(s.base, { "x-gbk-test-user": "alice" }); await c.initialize();
    const long = await c.call<{ compositionId: string }>("gbk_create_composition", { title: "Long", style: "classical", bars: 16, tempo: 60, seed: 1 });
    await assert.rejects(c.call("gbk_render_composition", { compositionId: long.compositionId }), errorCode("QUOTA_EXCEEDED"), "duration cap");
    const g = await c.call<{ compositionId: string }>("gbk_create_composition", { title: "Short", style: "pop", bars: 2, tempo: 120, seed: 2 });
    const r = await c.call<Job>("gbk_render_composition", { compositionId: g.compositionId, waitSeconds: 110 });
    assert.equal(r.status, "completed", JSON.stringify(r.error));
    assert.deepEqual(r.artifacts.map((a) => a.kind).sort(), ["midi", "wav"]);
    await assert.rejects(c.call("gbk_render_composition", { compositionId: g.compositionId }), errorCode("QUOTA_EXCEEDED"), "hourly rate");
  } finally { await s.app.close(); }
});

test("server render limits by plan: Stripe Pro gets 120/h + 600 s, free account 30/h + 300 s, guests unchanged; hourly boundary per plan", { timeout: 180_000 }, async () => {
  const state = { pro: new Set(["pro@example.com"]), down: false, calls: [] as string[] };
  const s = await startServer(model(), { MCP_TEST_AUTH: "1", COMPOSE_ENTITLEMENT_ORIGIN: "https://billing.test", COMPOSE_ENTITLEMENT_TOKEN: "test-entitlement-token" }, { fetch: entitlementFetch(state) });
  try {
    const pro = s.accounts.upsertOAuth("google", "g-pro", "Pro", "pro@example.com").account.id;
    const free = s.accounts.upsertOAuth("google", "g-free", "Free", "free@example.com").account.id;
    const r = s.mcp.renders;
    await r.refreshPro(pro); await r.refreshPro(free);
    assert.deepEqual(r.serverLimits(pro, false), { tier: "pro", perHour: 120, maxSeconds: 600 });
    assert.deepEqual(r.serverLimits(free, false), { tier: "free", perHour: 30, maxSeconds: 300 });
    assert.deepEqual(r.serverLimits("guest:abc", true), { tier: "guest", perHour: 6, maxSeconds: 180 });
    assert.equal(s.limits.for(pro).pro, true); assert.equal(s.limits.for(free).pro, false);
  } finally { await s.app.close(); }
  // Boundary: free 1/h vs Pro 2/h (scaled down); the free account's 2nd render is refused, the Pro account's 2nd succeeds and its 3rd is refused.
  const s2 = await startServer(model(), { MCP_TEST_AUTH: "1", SERVER_RENDER_ACCOUNT_PER_HOUR: "1", SERVER_RENDER_PRO_PER_HOUR: "2", SERVER_RENDER_ACCOUNT_MAX_SECONDS: "20", SERVER_RENDER_PRO_MAX_SECONDS: "60",
    COMPOSE_ENTITLEMENT_ORIGIN: "https://billing.test", COMPOSE_ENTITLEMENT_TOKEN: "test-entitlement-token" }, { fetch: entitlementFetch(state) });
  try {
    const pro = s2.accounts.upsertOAuth("google", "g-pro", "Pro", "pro@example.com").account.id;
    const free = s2.accounts.upsertOAuth("google", "g-free", "Free", "free@example.com").account.id;
    for (const [user, allowed] of [[free, 1], [pro, 2]] as const) {
      const c = new McpClient(s2.base, { "x-gbk-test-user": user }); await c.initialize();
      const g = await c.call<{ compositionId: string }>("gbk_create_composition", { title: "Short", style: "pop", bars: 2, tempo: 120, seed: 2 });
      for (let i = 0; i < allowed; i++) { const j = await c.call<Job>("gbk_render_composition", { compositionId: g.compositionId, waitSeconds: 110 }); assert.equal(j.status, "completed", JSON.stringify(j.error)); }
      await assert.rejects(c.call("gbk_render_composition", { compositionId: g.compositionId }), errorCode("QUOTA_EXCEEDED"), `${user === pro ? "pro" : "free"} hourly boundary`);
    }
    // duration: a ~32 s piece is over the free cap (20 s) but inside Pro's (60 s)
    const cp = new McpClient(s2.base, { "x-gbk-test-user": pro }); await cp.initialize();
    const cf = new McpClient(s2.base, { "x-gbk-test-user": free }); await cf.initialize();
    const lp = await cp.call<{ compositionId: string }>("gbk_create_composition", { title: "Mid", style: "classical", bars: 8, tempo: 60, seed: 1 });
    const lf = await cf.call<{ compositionId: string }>("gbk_create_composition", { title: "Mid", style: "classical", bars: 8, tempo: 60, seed: 1 });
    await assert.rejects(cf.call("gbk_render_composition", { compositionId: lf.compositionId }), (e: unknown) => /free plan.s limit \(20 s per server render\)/.test(JSON.stringify(e) + String((e as Error)?.message)), "free duration cap");
    await assert.rejects(cp.call("gbk_render_composition", { compositionId: lp.compositionId }), (e: unknown) => !/s per server render/.test(JSON.stringify(e) + String((e as Error)?.message)), "pro passes the duration cap (then hits its hourly limit)");
  } finally { await s2.app.close(); }
});

const SELLING = [/\/pricing/i, /checkout/i, /upgrade/i, /go pro/i, /\$\s?\d/, /\d+(\.\d+)?\s?(usd|€|£)/i, /per month|\/mo\b|\/month/i];
const assertNotSelling = (text: string, what: string) => { for (const re of SELLING) assert.ok(!re.test(text), `${what} must not contain ${re}: ${text.slice(0, 300)}`); };

test("MCP limit messages are informational only: plan + /plans link, never pricing, checkout, upgrade or a price (#122)", { timeout: 120_000 }, async () => {
  const s = await startServer(model(), { MCP_TEST_AUTH: "1", SERVER_RENDER_ACCOUNT_PER_HOUR: "1", SERVER_RENDER_ACCOUNT_MAX_SECONDS: "20", SERVER_RENDER_GUEST_PER_HOUR: "1" });
  try {
    const raw: string[] = [];
    const c = new McpClient(s.base, { "x-gbk-test-user": "carol" }); await c.initialize();
    raw.push(JSON.stringify((await c.send("tools/list", {})).rpc));
    const long = await c.call<{ compositionId: string }>("gbk_create_composition", { title: "Long", style: "classical", bars: 16, tempo: 60, seed: 1 });
    const dur = await c.callRaw("gbk_render_composition", { compositionId: long.compositionId }); raw.push(JSON.stringify(dur.rpc));
    assert.match(JSON.stringify(dur.rpc), /This is over the free plan's limit \(20 s per server render\)\. Plans: http:\/\/composer\.test\/plans/);
    const g = await c.call<{ compositionId: string }>("gbk_create_composition", { title: "Short", style: "pop", bars: 2, tempo: 120, seed: 2 });
    const ok = await c.callRaw("gbk_render_composition", { compositionId: g.compositionId, waitSeconds: 110 }); raw.push(JSON.stringify(ok.rpc));
    const hour = await c.callRaw("gbk_render_composition", { compositionId: g.compositionId }); raw.push(JSON.stringify(hour.rpc));
    assert.match(JSON.stringify(hour.rpc), /This is over the free plan's limit \(1 per hour\)\. Plans: http:\/\/composer\.test\/plans/);
    // guest path too
    const gc = new McpClient(s.base); await gc.initialize();
    const gg = await gc.call<{ compositionId: string; accessToken: string }>("gbk_create_composition", { title: "G", style: "pop", bars: 2, tempo: 120, seed: 4 });
    raw.push(JSON.stringify((await gc.callRaw("gbk_render_composition", { compositionId: gg.compositionId, accessToken: gg.accessToken, waitSeconds: 110 })).rpc));
    const gh = await gc.callRaw("gbk_render_composition", { compositionId: gg.compositionId, accessToken: gg.accessToken }); raw.push(JSON.stringify(gh.rpc));
    assert.match(JSON.stringify(gh.rpc), /over the free plan's limit \(1 per hour\)\. Plans: http:\/\/composer\.test\/plans/);
    raw.forEach((t, i) => assertNotSelling(t, `MCP output #${i}`));
  } finally { await s.app.close(); }
});
