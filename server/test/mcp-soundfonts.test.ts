// MCP SoundFont selection: gbk_list_soundfonts + gbk_render_composition's soundFont option.
//
// The server validates the catalog id once, before any branch creates a job (unknown ->
// INVALID_ARGUMENT, catalog font not installed in this deployment -> NOT_FOUND). Every render
// executor honors the selection: the headless server pool's workers parse the selected file
// (cached by path), and the Studio tab loads it via the deployment manifest + shared loader.
// Artifact provenance (meta.soundFont) names the font that actually rendered.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { ScriptModel, reply, testConfig } from "./helpers.ts";
import { startServer, login, TestTab } from "./ws-helpers.ts";
import { McpClient } from "./mcp-helpers.ts";
import { parseSoundFont, type LoadedSoundFont } from "../../src/audio/soundfont-loader.ts";
import { listSoundFonts } from "../src/mcp/soundfonts.ts";
import { BrowserToolBridge, type McpRenderDeps } from "../../src/agent/browser-bridge.ts";
import { WorkstationController } from "../../src/workstation/controller.ts";
import { buildAllTools } from "../../src/webmcp/registry.ts";
import { runTool } from "../../src/webmcp/tools.ts";

const model = () => new ScriptModel([() => reply("x")]);
const asUser = (s: { base: string }, user: string) => new McpClient(s.base, { "x-gbk-test-user": user });
const errCode = (e: unknown) => (e as { payload?: { error?: { code?: string } } }).payload?.error?.code;

function readIf(path: string): Uint8Array | null {
  try { return new Uint8Array(readFileSync(path)); } catch { return null; }
}
// TimGM6mb is a pinned download (gitignored): prefer the fetch cache, then the built public copy.
// When neither exists in this checkout the positive selection branches become NOT_FOUND ones.
const timBytes = readIf(new URL("../../soundfonts/TimGM6mb.sf2", import.meta.url).pathname)
  ?? readIf(new URL("../../public/static/TimGM6mb.sf2", import.meta.url).pathname);
const fluidInstalled = existsSync(new URL("../../soundfonts/FluidR3_GM.sf2", import.meta.url).pathname)
  || existsSync("/var/www/gbk-composer/soundfonts/FluidR3_GM.sf2");

interface FontView { id: string; label: string; delivery: string; path: string; default: boolean; active: boolean; available: boolean; bytes: number }
interface RenderedJob {
  status: string; renderedOn?: string; config: { soundFont?: string; executor: string };
  artifacts: { kind: string; sha256: string; meta: { soundFont?: string; validated?: boolean } }[];
}

test("gbk_list_soundfonts returns the pinned catalog with honest availability; capabilities embed it", async () => {
  const s = await startServer(model(), { MCP_TEST_AUTH: "1" });
  try {
    const alice = asUser(s, "alice"); await alice.initialize();
    const { fonts, defaultFontId } = await alice.call<{ fonts: FontView[]; defaultFontId: string }>("gbk_list_soundfonts", {});
    assert.deepEqual(fonts.map((f) => f.id), ["generaluser-gs", "timgm6mb", "fluidr3-gm"]);
    assert.equal(defaultFontId, "generaluser-gs");
    const gu = fonts[0];
    assert.equal(gu.default, true); assert.equal(gu.active, true);
    assert.equal(gu.available, true, "the committed public/static GeneralUser copy is always present");
    assert.equal(gu.delivery, "bundled"); assert.equal(gu.path, "static/GeneralUser-GS.sf2");
    const fluid = fonts[2];
    assert.equal(fluid.delivery, "server"); assert.equal(fluid.path, "/soundfonts/FluidR3_GM.sf2");
    assert.equal(fluid.available, fluidInstalled);
    // The tool output matches the catalog module's own view of this deployment.
    const direct = listSoundFonts(testConfig({}));
    assert.deepEqual(fonts.map((f) => [f.id, f.available]), direct.map((f) => [f.id, f.available]));

    const caps = await alice.call<{ capabilities: { soundFonts: FontView[]; soundFont: string } }>("gbk_get_capabilities", {});
    assert.equal(caps.capabilities.soundFonts.length, 3);
    assert.match(caps.capabilities.soundFont, /gbk_list_soundfonts/);
  } finally { await s.app.close(); }
});

test("headless server render honors soundFont: selected font renders, provenance names it, audio differs", { timeout: 300_000 }, async () => {
  const s = await startServer(model());
  try {
    const guest = new McpClient(s.base); await guest.initialize();
    const g = await guest.call<{ compositionId: string; accessToken: string }>("gbk_create_composition", { title: "SF server render", style: "classical", bars: 2, tempo: 120, seed: 3 });

    const dflt = await guest.call<RenderedJob>("gbk_render_composition", { compositionId: g.compositionId, accessToken: g.accessToken, waitSeconds: 110, tailSeconds: 1 });
    assert.equal(dflt.status, "completed", JSON.stringify(dflt));
    assert.equal(dflt.renderedOn, "server"); assert.equal(dflt.config.executor, "server");
    assert.equal(dflt.artifacts.find((x) => x.kind === "wav")!.meta.soundFont, "GeneralUser-GS.sf2");

    if (timBytes) {
      const sel = await guest.call<RenderedJob>("gbk_render_composition", { compositionId: g.compositionId, accessToken: g.accessToken, soundFont: "timgm6mb", waitSeconds: 110, tailSeconds: 1 });
      assert.equal(sel.status, "completed", JSON.stringify(sel));
      assert.equal(sel.config.soundFont, "timgm6mb");
      const selWav = sel.artifacts.find((x) => x.kind === "wav")!;
      assert.equal(selWav.meta.soundFont, "TimGM6mb.sf2", "the server worker rendered with the selected font");
      assert.notEqual(selWav.sha256, dflt.artifacts.find((x) => x.kind === "wav")!.sha256, "a different SoundFont renders different audio");
    } else {
      await assert.rejects(guest.call("gbk_render_composition", { compositionId: g.compositionId, accessToken: g.accessToken, soundFont: "timgm6mb" }),
        (e: unknown) => errCode(e) === "NOT_FOUND");
    }
  } finally { await s.app.close(); }
});

test("Studio-tab render honors soundFont; validation fails before any job reaches the tab", { timeout: 300_000 }, async () => {
  const s = await startServer(model(), { MCP_TEST_AUTH: "1" });
  try {
    const alice = asUser(s, "alice"); await alice.initialize();
    const c = await alice.call<{ compositionId: string }>("gbk_create_composition", {
      title: "SF Test Fugue", style: "baroque", key: "D minor", tempo: 108, bars: 4, seed: 7,
      instrumentation: ["organ", "organ", "organ"], idempotencyKey: "sf-test-create-1",
    });

    const seen: string[] = [];
    const guSf = parseSoundFont(new Uint8Array(readFileSync(new URL("../../public/static/GeneralUser-GS.sf2", import.meta.url))), "test-sf", "GeneralUser-GS.sf2");
    const deps: McpRenderDeps = {
      soundFont: guSf,
      http: (u, i) => fetch(u.replace(s.cfg.publicOrigin, s.base), i),
      loadSoundFont: async (id: string) => {
        seen.push(id);
        if (!timBytes) throw Object.assign(new Error("tim not installed"), { code: "NOT_FOUND" });
        return parseSoundFont(timBytes, "test-tim", "TimGM6mb.sf2") as LoadedSoundFont;
      },
    };
    const a = await login(s.base, "code-a");
    const tab = new TestTab(undefined, deps);
    await tab.open(s.base, a.cookie);
    const renderJobs = () => tab.executed.filter((t) => t === "gbk_mcp_render_job").length;

    // Unknown id: typed error at submit, and the tab is never asked to render.
    const before = renderJobs();
    await assert.rejects(alice.call("gbk_render_composition", { compositionId: c.compositionId, soundFont: "no-such-font" }),
      (e: unknown) => errCode(e) === "INVALID_ARGUMENT");
    assert.equal(renderJobs(), before, "no render job reached the tab for an unknown soundFont id");

    if (timBytes) {
      const sel = await alice.call<RenderedJob>("gbk_render_composition", { compositionId: c.compositionId, soundFont: "timgm6mb", waitSeconds: 120, tailSeconds: 1 });
      assert.equal(sel.status, "completed", JSON.stringify(sel));
      assert.equal(sel.config.soundFont, "timgm6mb");
      assert.deepEqual(seen, ["timgm6mb"], "the tab was asked to load exactly the selected font");
      assert.equal(sel.artifacts.find((x) => x.kind === "wav")!.meta.soundFont, "TimGM6mb.sf2");
    } else {
      await assert.rejects(alice.call("gbk_render_composition", { compositionId: c.compositionId, soundFont: "timgm6mb" }),
        (e: unknown) => errCode(e) === "NOT_FOUND");
    }

    if (!fluidInstalled) {
      await assert.rejects(alice.call("gbk_render_composition", { compositionId: c.compositionId, soundFont: "fluidr3-gm" }),
        (e: unknown) => errCode(e) === "NOT_FOUND", "server-only font absent from this deployment");
    }
    tab.close();
  } finally { await s.app.close(); }
});

test("tab bridge default loader: manifest id -> font load -> render provenance (no injected loader)", { timeout: 300_000, skip: timBytes ? false : "TimGM6mb.sf2 not fetched in this checkout" }, async () => {
  const c = new WorkstationController();
  const tools = new Map(buildAllTools(c).map((t) => [t.name, t]));
  const sig = new AbortController().signal;
  assert.equal((await runTool(c, tools.get("gbk_create_project")!, { name: "SF Bridge", tempo: 108, key: "D minor" }, sig)).ok, true);
  assert.equal((await runTool(c, tools.get("gbk_generate_arrangement")!, { style: "baroque", key: "D minor", bars: 4, seed: 3 }, sig)).ok, true);

  const uploaded: Uint8Array[] = [];
  const manifest = [{ id: "timgm6mb", label: "TimGM6mb (Light)", file: "TimGM6mb.sf2", path: "static/TimGM6mb.sf2", bytes: timBytes!.length }];
  const http = async (u: string, i?: RequestInit): Promise<Response> => {
    if (u.endsWith("soundfont-manifest.json")) return new Response(JSON.stringify(manifest), { headers: { "content-type": "application/json" } });
    if (u.endsWith("TimGM6mb.sf2")) return new Response(timBytes as BodyInit, { headers: { "content-type": "application/octet-stream" } });
    if (u.endsWith("/snapshot")) return new Response(JSON.stringify({ project: c.project }), { headers: { "content-type": "application/json" } });
    if (i?.method === "PUT") { uploaded.push(new Uint8Array(await new Response(i.body).arrayBuffer())); return new Response(null, { status: 200 }); }
    return new Response("not found", { status: 404 });
  };
  const bridge = new BrowserToolBridge(c, undefined, { http });
  const job = (soundFontId: string) => ({
    type: "tool_call" as const, sessionId: "s1", runId: "r1", callId: `call-${soundFontId}`, tool: "gbk_mcp_render_job",
    arguments: {
      jobId: "job1", token: "t", snapshotUrl: "http://tab.test/api/mcp/render-jobs/job1/snapshot", uploadUrl: "http://tab.test/api/mcp/render-jobs/job1/wav",
      options: { sampleRate: 44100, channels: 2, format: "pcm16", normalize: "loudness", tailSeconds: 1, maxSeconds: 60 },
      ...(soundFontId ? { soundFontId } : {}),
    },
    expectProjectId: null, consent: { newProject: false }, deadlineMs: 300_000,
  });

  const env = await bridge.execute(job("timgm6mb"), "s1");
  assert.equal(env.ok, true, JSON.stringify(env));
  assert.equal((env.data as { soundFont?: string }).soundFont, "TimGM6mb.sf2", "provenance names the manifest-loaded font");
  const wav = Buffer.concat(uploaded.map((u) => Buffer.from(u)));
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF", "the tab uploaded a real WAV rendered with the selected font");

  const miss = await bridge.execute(job("no-such-font"), "s1");
  assert.equal(miss.ok, false);
  assert.equal(miss.error?.code, "NOT_FOUND", "an id missing from the deployment manifest fails in the tab with NOT_FOUND");
});
