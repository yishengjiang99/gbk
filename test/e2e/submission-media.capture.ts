// OpenAI submission media capture. See submission.config.ts. Outputs to $GBK_SUBMISSION_OUT (default /workspace/shots/submission).
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, copyFileSync, readFileSync } from "node:fs";
import { COMPOSER_UI_HTML } from "../../server/src/mcp/ui.ts";

const OUT = process.env.GBK_SUBMISSION_OUT ?? "/workspace/shots/submission";
const API = "http://127.0.0.1:8781";
const plugin = JSON.parse(readFileSync(new URL("../../plugins/gbk-composer/plugin.json", import.meta.url), "utf8"));
const PROMPTS: string[] = plugin.extensions["com.openai"].interface.defaultPrompt;
const STUDIO_PROMPT = "Compose a four-voice Baroque fugue in D minor with expressive strings, add CC11 dynamics, and render it to WAV.";

class Mcp {
  sid = ""; seq = 0;
  async send(method: string, params: unknown, notify = false) {
    const r = await fetch(`${API}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-gbk-test-user": "tester", ...(this.sid ? { "mcp-session-id": this.sid } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(notify ? {} : { id: ++this.seq }), method, params }) });
    this.sid = r.headers.get("mcp-session-id") ?? this.sid; const t = await r.text();
    const line = t.split("\n").find((l) => l.startsWith("data:")); return line ? JSON.parse(line.slice(5)) : t ? JSON.parse(t) : null;
  }
  async init() { await this.send("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "capture", version: "0" } }); await this.send("notifications/initialized", {}, true); }
  async call(name: string, args: Record<string, unknown> = {}) {
    const r = await this.send("tools/call", { name, arguments: args }); const res = r.result;
    if (res.isError) throw new Error(`${name}: ${res.content[0].text}`); return res.structuredContent as Record<string, any>;
  }
}

async function signIn(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("gbk:need-signin", { detail: { why: "Sign in", pending: null } })));
  await page.getByTestId("signin-code").fill("e2e-code"); await page.getByTestId("signin-code-submit").click(); await page.getByTestId("signin-sheet").waitFor({ state: "hidden" });
  await expect(page.getByTestId("composer-conn")).toHaveAttribute("data-state", "connected", { timeout: 30_000 });
}

async function shootPlayer(page: Page, sc: Record<string, unknown>, file: string) {
  await page.setViewportSize({ width: 706, height: 860 });
  await page.addInitScript((d) => { (window as any).openai = { toolOutput: d }; }, sc);
  await page.setContent(COMPOSER_UI_HTML.replace("<head>", `<head><base href="${API}/">`), { waitUntil: "load" });
  await page.evaluate((d) => window.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: d } }, "*"), sc);
  await page.waitForTimeout(800);
  const h = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
  const height = Math.min(860, Math.max(400, h));
  await page.screenshot({ path: `${OUT}/${file}`, clip: { x: 0, y: 0, width: 706, height } });
}

test("capture demo recording + starter-prompt screenshots", async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  // ---- demo recording: studio session (compose prompt -> piano roll -> browser render -> playback) ----
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: `${OUT}/raw`, size: { width: 1280, height: 800 } } });
  const studio = await ctx.newPage();
  await studio.goto("/"); await studio.waitForTimeout(1500);
  await studio.getByTestId("compose-cta").click(); await expect(studio.getByTestId("workstation")).toBeVisible();
  await signIn(studio); await studio.waitForTimeout(800);
  await studio.getByTestId("composer-input").pressSequentially(STUDIO_PROMPT, { delay: 25 });
  await studio.getByTestId("composer-input").press("Enter");
  await expect(studio.getByTestId("piano-roll")).toBeVisible();
  await expect(studio.getByTestId("version-card").last()).toBeVisible({ timeout: 540_000 }); // the finished song card (no raw artifact id)
  const dlg = studio.getByTestId("publish-dialog");
  if (await dlg.isVisible({ timeout: 20_000 }).catch(() => false)) { await studio.waitForTimeout(1200); await studio.getByTestId("publish-cancel").click(); }
  await studio.getByTestId("ws-play").click(); await studio.waitForTimeout(12_000);
  await studio.getByRole("button", { name: "Pause" }).click().catch(() => {});
  const video = studio.video()!;
  await ctx.close(); copyFileSync(await video.path(), `${OUT}/demo-raw.webm`);
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const tab = await ctx2.newPage();
  await tab.goto("/studio"); await signIn(tab);

  // ---- starter-prompt screenshots: same tool sequence ChatGPT runs, rendered in this connected studio tab ----
  const mcp = new Mcp(); await mcp.init();
  const shot = await browser.newPage();
  // 1) Baroque fugue in D minor for organ -> piano roll
  const c1 = await mcp.call("gbk_create_composition", { title: "Fugue in D minor", style: "baroque", key: "D minor", bars: 16, instrumentation: ["organ", "organ", "organ", "organ"], idempotencyKey: "capture-prompt-1" });
  await shootPlayer(shot, await mcp.call("gbk_show_composition_ui", { compositionId: c1.compositionId }), "starter-1-baroque-fugue.png");
  // 2) jazz in F at 140 BPM + walking bass -> render WAV and MIDI in the studio tab
  const c2 = await mcp.call("gbk_create_composition", { title: "Jazz in F", style: "jazz", key: "F major", tempo: 140, bars: 24, idempotencyKey: "capture-prompt-2" });
  const g2 = await mcp.call("gbk_get_composition", { compositionId: c2.compositionId });
  const bassTrack = (g2.tracks as { id: string; name: string }[]).find((t) => /bass/i.test(t.name)) ?? (g2.tracks as { id: string }[]).slice(-1)[0]!;
  await mcp.call("gbk_edit_composition", { compositionId: c2.compositionId, expectedRevision: g2.revision, operations: [{ type: "generate_part", track: bassTrack.id, startBar: 1, endBar: 24, kind: "walking_bass" }] });
  const r2 = await mcp.call("gbk_render_composition", { compositionId: c2.compositionId, waitSeconds: 120, tailSeconds: 2 });
  expect(r2.status).toBe("completed");
  await shootPlayer(shot, await mcp.call("gbk_show_composition_ui", { compositionId: c2.compositionId }), "starter-2-jazz-walking-bass.png");
  // 3) "my last piece": bass doubled an octave lower in bars 9-16 + CC11 crescendo
  const last = (await mcp.call("gbk_list_compositions", { limit: 1 })).items[0];
  const g3 = await mcp.call("gbk_get_composition", { compositionId: last.compositionId });
  const tracks = g3.tracks as { id: string; name: string }[]; const bass = tracks.find((t) => /bass/i.test(t.name)) ?? tracks.slice(-1)[0]!;
  const target = tracks.find((t) => t.id !== bass.id)!;
  await mcp.call("gbk_edit_composition", { compositionId: last.compositionId, expectedRevision: g3.revision, operations: [
    { type: "orchestrate", sourceTrack: bass.id, targetTrack: target.id, startBar: 9, endBar: 16, semitones: -12 },
    { type: "cc_curve", trackIds: tracks.map((t) => t.id), controller: 11, startBar: 9, endBar: 16, shape: "crescendo" }] });
  await shootPlayer(shot, await mcp.call("gbk_show_composition_ui", { compositionId: last.compositionId }), "starter-3-octave-crescendo.png");
  await shot.close();
  await ctx2.close();
  console.log("prompts", JSON.stringify(PROMPTS));
});
