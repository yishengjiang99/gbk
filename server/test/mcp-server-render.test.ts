// Headless server rendering: an MCP client with no browser (guest or signed-in, no Studio tab) gets a validated
// WAV and a Standard MIDI File as signed download URLs, rendered by the app's own SF2 engine in a worker thread.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer } from "./ws-helpers.ts";
import { McpClient } from "./mcp-helpers.ts";

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

test("SERVER_RENDER=0 is the off switch: no server WAV; guests get MIDI + browser handoff, accounts studio_required", async () => {
  const s = await startServer(model(), { SERVER_RENDER: "0", MCP_TEST_AUTH: "1" });
  try {
    const c = new McpClient(s.base); await c.initialize();
    const g = await c.call<{ compositionId: string; accessToken: string }>("gbk_create_composition", { title: "Off", style: "classical", bars: 2, seed: 3 });
    const r = await c.call<Job>("gbk_render_composition", { compositionId: g.compositionId, accessToken: g.accessToken });
    assert.equal(r.status, "browser_render"); assert.deepEqual(r.artifacts.map((a) => a.kind), ["midi"]);
    const a = new McpClient(s.base, { "x-gbk-test-user": "bob" }); await a.initialize();
    const b = await a.call<{ compositionId: string }>("gbk_create_composition", { title: "Off2", style: "classical", bars: 2, seed: 3 });
    assert.equal((await a.call<Job>("gbk_render_composition", { compositionId: b.compositionId })).status, "studio_required");
  } finally { await s.app.close(); }
});
