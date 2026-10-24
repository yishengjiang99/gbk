// WAV rendering goes through an OfflineAudioContext (the browser's; a stand-in under Node) - never a main-thread
// engine loop, never the server. Covers the iOS fallback, progress, Stop/cancel, stall + timeout watchdogs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FakeOfflineAudioContext, FakeAudioWorkletNode } from "./support/offline-audio-context.ts";
import { parseSoundFont } from "../src/audio/soundfont-loader.ts";
import { renderProjectOffline, type OfflineRenderOptions } from "../src/audio/offline-renderer.ts";
import { browserOfflineEnv, type OfflineEnv, type OfflineCtx } from "../src/audio/offline-context.ts";
import { RenderError } from "../src/audio/render-error.ts";
import { RenderJobManager } from "../src/audio/render-job.ts";
import { ArtifactStore, MemoryArtifactBackend } from "../src/audio/artifact-store.ts";
import { BrowserToolBridge } from "../src/agent/browser-bridge.ts";
import { WorkstationController } from "../src/workstation/controller.ts";
import { emptyProject, type Project } from "../src/workstation/model.ts";
import { applyOps } from "../src/workstation/ops.ts";
import { renderJobs } from "../src/audio/render-job.ts";
import "./support/compose-setup.ts";

const SF = parseSoundFont(new Uint8Array(readFileSync("public/static/GeneralUser-GS.sf2")), "GeneralUser-GS.sf2");
const OPT: OfflineRenderOptions = { sampleRate: 44100, channels: 2, format: "pcm16", tailSeconds: 1 };
function song(bars = 2): Project {
  return applyOps(emptyProject("ambient"), [
    { op: "addTrack", id: "t1", name: "Pad", channel: 0 }, { op: "setProgram", trackId: "t1", program: 89, bankMsb: 0, bankLsb: 0 },
    { op: "addTrack", id: "t2", name: "Strings", channel: 1 }, { op: "setProgram", trackId: "t2", program: 48, bankMsb: 0, bankLsb: 0 },
    { op: "addNotes", notes: Array.from({ length: bars }, (_, b) => [{ trackId: "t1", channel: 0, tick: b * 1920, duration: 1900, pitch: 62, velocity: 90 }, { trackId: "t2", channel: 1, tick: b * 1920, duration: 1900, pitch: 50, velocity: 90 }]).flat() },
  ]);
}
const g = globalThis as Record<string, unknown>;
async function withGlobals<T>(over: Record<string, unknown>, f: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(over).map((k) => [k, g[k]]));
  for (const [k, v] of Object.entries(over)) { if (v === undefined) delete g[k]; else g[k] = v; }
  try { return await f(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; } }
}

test("renders through an OfflineAudioContext + sf2-processor AudioWorklet (one node per audible track)", async () => {
  const before = FakeOfflineAudioContext.created; let nodes = 0;
  const env = browserOfflineEnv();
  const counting: OfflineEnv = { ...env, createWorkletNode: (c, n, o) => { nodes++; return env.createWorkletNode(c, n, o); } };
  const prog: number[] = [];
  const r = await renderProjectOffline(song(), OPT, undefined, (x, st) => { if (st === "rendering") prog.push(x); }, { soundFont: SF, offlineEnv: counting });
  assert.equal(FakeOfflineAudioContext.created, before + 1);
  assert.equal(nodes, 2);
  assert.equal(r.validated, true); assert.ok(r.peakDbFS > -40);
  assert.ok(prog.length >= 2 && prog.every((x, i) => i === 0 || x >= prog[i - 1]), "monotonic progress from suspend() checkpoints");
});

test("iOS Safari: falls back to webkitOfflineAudioContext; no OfflineAudioContext at all -> RENDER_UNSUPPORTED (never a main-thread fallback)", async () => {
  const r = await withGlobals({ OfflineAudioContext: undefined, webkitOfflineAudioContext: FakeOfflineAudioContext }, () => renderProjectOffline(song(1), OPT, undefined, undefined, { soundFont: SF }));
  assert.equal(r.validated, true);
  await withGlobals({ OfflineAudioContext: undefined, webkitOfflineAudioContext: undefined }, async () => {
    await assert.rejects(renderProjectOffline(song(1), OPT, undefined, undefined, { soundFont: SF }), (e: RenderError) => e.code === "RENDER_UNSUPPORTED");
  });
  await withGlobals({ AudioWorkletNode: undefined }, async () => {
    await assert.rejects(renderProjectOffline(song(1), OPT, undefined, undefined, { soundFont: SF }), (e: RenderError) => e.code === "RENDER_UNSUPPORTED" && /AudioWorklet/.test(e.message));
  });
  assert.equal(g.AudioWorkletNode, FakeAudioWorkletNode);
});

test("Stop: abort mid-render rejects promptly and the offline context is never resumed", async () => {
  let ctx: FakeOfflineAudioContext | null = null;
  const env = browserOfflineEnv();
  const spy: OfflineEnv = { ...env, createContext: (c, l, sr) => (ctx = env.createContext(c, l, sr) as unknown as FakeOfflineAudioContext) as unknown as OfflineCtx };
  const ac = new AbortController(); const t0 = Date.now();
  const p = renderProjectOffline(song(16), OPT, ac.signal, (x, st) => { if (st === "rendering" && x > 0 && x < 0.9) ac.abort(); }, { soundFont: SF, offlineEnv: spy });
  await assert.rejects(p, (e: RenderError) => e.code === "OPERATION_CANCELLED");
  assert.ok(Date.now() - t0 < 20_000);
  // The fake audio thread reaches its next 2 s checkpoint, parks there, and is never resumed.
  for (let i = 0; i < 200 && ctx!.state !== "suspended"; i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(ctx!.state, "suspended", "audio thread parked at the checkpoint, not still rendering");
});

/** A context whose audio thread never advances (what a wedged render looks like). */
const wedged: OfflineEnv = {
  createContext: (_c, length, sampleRate) => ({ sampleRate, length, destination: { connect() {} } as unknown as AudioNode, audioWorklet: { addModule: async () => {} },
    createChannelSplitter: () => ({ connect() {} }) as unknown as ChannelSplitterNode, createChannelMerger: () => ({ connect() {} }) as unknown as ChannelMergerNode,
    createGain: () => ({ gain: { value: 1 }, connect() {} }) as unknown as GainNode, startRendering: () => new Promise<AudioBuffer>(() => {}), suspend: () => new Promise<void>(() => {}), resume: async () => {} }),
  createWorkletNode: () => { const port = { onmessage: null as ((e: MessageEvent) => void) | null, postMessage(m: { type: string }) { if (m.type === "setSequence") setTimeout(() => port.onmessage?.({ data: { type: "sequenceReady" } } as MessageEvent)); } };
    return { port, connect() {} } as unknown as AudioWorkletNode; },
  workletUrl: async () => "x",
};

test("a render that stops making progress fails with RENDER_STALLED (no endless 'Rendering WAV')", async () => {
  await assert.rejects(renderProjectOffline(song(1), { ...OPT, stallMs: 1500 }, undefined, undefined, { soundFont: SF, offlineEnv: wedged }), (e: RenderError) => e.code === "RENDER_STALLED" && /no progress/.test(e.message));
});

test("overall timeout fails with RENDER_TIMEOUT and a clear message", async () => {
  await assert.rejects(renderProjectOffline(song(1), { ...OPT, timeoutMs: 1500, stallMs: 60_000 }, undefined, undefined, { soundFont: SF, offlineEnv: wedged }), (e: RenderError) => e.code === "RENDER_TIMEOUT" && /took longer than/.test(e.message));
});

test("cancelled job frees the FIFO: the next render runs", async () => {
  const jobs = new RenderJobManager(() => new ArtifactStore(new MemoryArtifactBackend()), { soundFont: SF });
  const a = jobs.submit(song(16), OPT);
  const off = jobs.subscribe((j) => { if (j.id === a.id && j.status === "rendering" && j.progress > 0.15) jobs.cancel(a.id); });
  assert.equal((await jobs.wait(a.id)).status, "cancelled"); off();
  const b = jobs.submit(song(1), OPT);
  assert.equal((await jobs.wait(b.id)).status, "completed");
});

test("Composer bridge: cancel(callId) (Stop / server cancel_call) stops an in-page render; real % progress is reported", async () => {
  const c = new WorkstationController(); const b = new BrowserToolBridge(c);
  c.load(song(16));
  const progress: string[] = [];
  const msg = { type: "tool_call" as const, sessionId: "s", runId: "r", callId: "rw", tool: "gbk_render_wav", arguments: { includeMidi: false }, expectProjectId: null, consent: { newProject: false }, deadlineMs: 600_000 };
  const p = b.execute(msg, "s", (x, d) => { if (d) progress.push(d); if (x > 0.2) b.cancel("rw"); });
  const r = await p;
  assert.equal(r.ok, false); assert.equal(r.error?.code, "OPERATION_CANCELLED");
  assert.ok(progress.some((d) => /rendering \d+%/.test(d)), JSON.stringify(progress.slice(0, 5)));
  assert.equal(renderJobs().list()[0].status, "cancelled");
});

test("Composer bridge: a render past its deadline returns RENDER_TIMEOUT (not a silent hang)", async () => {
  const c = new WorkstationController(); const b = new BrowserToolBridge(c);
  c.load(song(32));
  const msg = { type: "tool_call" as const, sessionId: "s", runId: "r2", callId: "rt", tool: "gbk_render_wav", arguments: { includeMidi: false }, expectProjectId: null, consent: { newProject: false }, deadlineMs: 6500 };
  const r = await b.execute(msg, "s");
  assert.equal(r.error?.code, "RENDER_TIMEOUT", JSON.stringify(r.error)); assert.match(r.error!.message, /OfflineAudioContext/);
});

test("audit: no synthesis outside the AudioWorklet; the server imports no audio engine", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
  const engineUsers = walk("src").filter((f) => /new Sf2SynthEngine\(/.test(readFileSync(f, "utf8"))).sort();
  assert.deepEqual(engineUsers, ["src/sf2-processor-core.ts", "src/sf2/parity.ts"], "only the worklet core (and the engine-parity harness) instantiate the engine");
  for (const f of walk("server/src")) {
    const s = readFileSync(f, "utf8");
    const imports = [...s.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(imports.filter((i) => /sf2-renderer|offline-renderer|offline-context|sf2-processor|render-job\.ts|wav-encoder|loudness|sf2\/soundfont/.test(i)), [], `${f} must not import an audio engine`);
    assert.doesNotMatch(s, /renderProjectOffline|Sf2SynthEngine|OfflineAudioContext\(/, `${f} must not synthesize audio`);
  }
  assert.doesNotMatch(readFileSync("src/audio/offline-renderer.ts", "utf8"), /renderRange|renderScheduled|dispatchEvent/);
});
