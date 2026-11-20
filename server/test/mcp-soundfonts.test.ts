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

interface FontView { id: string; label: string; delivery: string; default: boolean; active: boolean; available: boolean; bytes: number; description: string }
interface RenderedJob {
  status: string; renderedOn?: string; config: { soundFont?: string; executor: string };
  artifacts: { kind: string; sha256: string; meta: { soundFont?: string; validated?: boolean } }[];
}

test("gbk_list_soundfonts returns the pinned catalog with honest availability; capabilities embed it", async () => {
  const s = await startServer(model(), { MCP_TEST_AUTH: "1" });
  try {
    const alice = asUser(s, "alice"); await alice.initialize();
    const { fonts, defaultFontId } = await alice.call<{ fonts: FontView[]; defaultFontId: string }>("gbk_list_soundfonts", {});
    assert.deepEqual(fonts.map((f) => f.id), ["generaluser-gs", "timgm6mb", "fluidr3-gm", "nostalgic-rock-guitar", "sms-drum-kit"]);
    assert.equal(defaultFontId, "generaluser-gs");
    const gu = fonts[0];
    assert.equal(gu.default, true); assert.equal(gu.active, true);
    assert.equal(gu.available, true, "the committed public/static GeneralUser copy is always present");
    assert.equal(gu.delivery, "bundled");
    // Plugin responses carry no internal file layout and no raw SF2 INFO block (which names
    // individual engineers/copyright holders): OpenAI review, 2026-11-19. The binary still
    // drives the description server-side (GeneralUser's long ICMT license comment becomes it).
    const raw = gu as unknown as Record<string, unknown>;
    assert.equal(raw.path, undefined); assert.equal(raw.file, undefined);
    assert.equal(raw.info, undefined); assert.equal(raw.presets, undefined); assert.equal(raw.presetCount, undefined);
    assert.match(gu.description, /License v2\.0/);
    const fluid = fonts[2];
    assert.equal(fluid.delivery, "server");
    assert.equal(fluid.available, fluidInstalled);
    // The vendored specialty banks are committed in-repo, so they are always installed;
    // with no ICMT in their binaries, the listing describes them from name + presets + credits.
    const guitar = fonts[3];
    assert.equal(guitar.available, true);
    assert.match(guitar.description, /Nostalgic Rock Guitar\.sf2: 1 preset/);
    assert.match(guitar.description, /Libre/);
    const drums = fonts[4];
    assert.equal(drums.available, true);
    assert.match(drums.description, /bank 128 program 0 "Drums"/);
    // The tool output matches the catalog module's own view of this deployment.
    const direct = listSoundFonts(testConfig({}));
    assert.deepEqual(fonts.map((f) => [f.id, f.available]), direct.map((f) => [f.id, f.available]));

    const caps = await alice.call<{ capabilities: { soundFonts: FontView[]; soundFont: string } }>("gbk_get_capabilities", {});
    assert.equal(caps.capabilities.soundFonts.length, 5);
    assert.match(caps.capabilities.soundFont, /gbk_list_soundfonts/);
  } finally { await s.app.close(); }
});
