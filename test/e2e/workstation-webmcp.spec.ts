import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseSmf } from "../../src/workstation/smf.ts";

const SHOTS = process.env.GBK_SHOTS ?? "/workspace/shots";
type R = { ok: boolean; revision: number; data: any; warnings: string[]; error?: { code: string; message: string } };

async function tool(page: Page, name: string, args: object = {}): Promise<R> {
  const out = await page.evaluate(async ([n, a]) => {
    const mc = (document as any).modelContext;
    const t = (await mc.getTools()).find((x: any) => x.name === n);
    if (!t) throw new Error(`tool ${n} not registered`);
    return await mc.executeTool(t, a);
  }, [name, args] as const);
  return JSON.parse(out as string);
}
/** Start a tool call that needs user approval, return a handle to await after clicking in the UI. */
async function startTool(page: Page, name: string, args: object) {
  await page.evaluate(([n, a]) => {
    const mc = (document as any).modelContext;
    (window as any).__pending = mc.getTools().then((ts: any[]) => mc.executeTool(ts.find((x) => x.name === n), a));
  }, [name, args] as const);
  return async () => JSON.parse(await page.evaluate(() => (window as any).__pending)) as R;
}

test("acceptance: real WebMCP tools drive the GBK workstation end to end", async ({ page }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.goto("/gbk/");
  await expect(page.getByTestId("workstation")).toBeVisible();
  // Load a bundled multi-track MIDI through the player modal (Habanera: strings + winds).
  await page.getByTestId("open-player").click();
  await expect(page.getByTestId("player-modal")).toHaveClass(/open/);
  await page.getByText(/habanera/i).first().click();
  await page.getByTestId("close-player").click();
  await expect(page.locator(".ws-name")).toContainText(/habanera/i, { timeout: 20_000 });

  // Enable agent tools + discover
  await page.getByTestId("agent-toggle").check();
  await expect(page.getByTestId("webmcp-status")).toHaveText(/WebMCP on/);
  const names: string[] = await page.evaluate(async () => (await (document as any).modelContext.getTools()).map((t: any) => t.name));
  expect(names).toEqual(expect.arrayContaining(["gbk_get_capabilities", "gbk_generate_cc_curve", "gbk_commit_proposal", "gbk_generate_counterpoint"]));
  await page.screenshot({ path: `${SHOTS}/gbk-ws-01-tools-enabled.png` });

  // Inspect
  const caps = await tool(page, "gbk_get_capabilities");
  expect(caps.data.controllers["91"].audible).toBe(false);
  const sum = await tool(page, "gbk_get_project_summary");
  expect(sum.ok).toBe(true);
  const tracks = (await tool(page, "gbk_list_tracks")).data as any[];
  const strings = tracks.filter((t) => t.notes > 0 && t.program && t.program.program >= 40 && t.program.program <= 51).map((t) => t.id);
  const noteTracks = tracks.filter((t) => t.notes > 0);
  const target = strings.length ? strings : [noteTracks[0].id];
  console.log("strings tracks:", target.length, "of", tracks.length);

  // Select bars 9-16 on strings
  const sel = await tool(page, "gbk_select_passage", { range: { unit: "bars", start: 9, end: 16 }, trackIds: target });
  expect(sel.data.noteCount).toBeGreaterThan(0);
  const rev0 = sel.revision;

  // CC11 crescendo proposal
  const cres = await tool(page, "gbk_generate_cc_curve", { trackIds: target, controller: 11, shape: "crescendo", from: 35, to: 120, range: { unit: "bars", start: 9, end: 16 }, density: { unit: "beats", step: 0.25 }, baseRevision: rev0 });
  expect(cres.ok).toBe(true);
  // Scroll the roll to bar 9 for the screenshot
  await page.getByTestId("piano-roll").focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  await page.screenshot({ path: `${SHOTS}/gbk-ws-02-cc11-crescendo-proposal.png` });

  // CC1 swell proposal, then reject it (no mutation)
  const swell = await tool(page, "gbk_generate_cc_curve", { trackIds: target, controller: 1, shape: "swell", from: 0, to: 0, peak: 100, range: { unit: "bars", start: 9, end: 16 } });
  const discarded = await tool(page, "gbk_discard_proposal", { proposalId: swell.data.proposalId });
  expect(discarded.revision).toBe(rev0);
  expect((await tool(page, "gbk_get_cc_events", { trackId: target[0], controller: 1, range: { unit: "bars", start: 9, end: 16 } })).data.total).toBe(0);

  // Accept the crescendo via the user-visible Accept button
  const done = await startTool(page, "gbk_commit_proposal", { proposalId: cres.data.proposalId });
  await expect(page.locator(".ws-approval")).toBeVisible();
  await page.getByTestId(`proposal-${cres.data.proposalId}`).getByRole("button", { name: "Accept" }).click();
  const committed = await done();
  expect(committed.ok).toBe(true);
  expect(committed.revision).toBe(rev0 + 1);
  const cc11 = await tool(page, "gbk_get_cc_events", { trackId: target[0], controller: 11, range: { unit: "bars", start: 9, end: 16 } });
  expect(cc11.data.total).toBeGreaterThan(8);
  const vals = cc11.data.events.map((e: any) => e.value);
  expect(vals[0]).toBe(35); expect(Math.max(...vals)).toBe(120);
  await page.screenshot({ path: `${SHOTS}/gbk-ws-03-cc11-committed-lane.png` });

  // Pans (mix default layer; undoable)
  for (const [i, id] of target.slice(0, 4).entries()) await tool(page, "gbk_set_track_mix", { trackId: id, pan: [32, 96, 48, 80][i] });

  // Alto counterpoint against the top strings line
  const cp = await tool(page, "gbk_generate_counterpoint", { cantusTrackId: target[0], range: { unit: "bars", start: 9, end: 16 }, register: { low: 55, high: 74 }, position: "below", rhythmComplexity: 1, seed: 42, candidates: 3, newTrackName: "Alto counterpoint" });
  expect(cp.ok).toBe(true);
  await page.screenshot({ path: `${SHOTS}/gbk-ws-04-counterpoint-proposal-overlay.png` });

  // A/B audition (real audio path; loads SoundFont on demand)
  const a = await tool(page, "gbk_preview_proposal", { proposalId: cp.data.proposalId, variant: "A" });
  const b = await tool(page, "gbk_preview_proposal", { proposalId: cp.data.proposalId, variant: "B" });
  console.log("preview A:", a.ok, a.error?.code, "B:", b.ok, b.error?.code);
  const revBefore = (await tool(page, "gbk_get_project_summary")).revision;
  expect(revBefore).toBe(committed.revision + Math.min(4, target.length));

  // Accept counterpoint, then undo/redo
  const done2 = await startTool(page, "gbk_commit_proposal", { proposalId: cp.data.proposalId });
  await page.getByTestId(`proposal-${cp.data.proposalId}`).getByRole("button", { name: "Accept" }).click();
  expect((await done2()).ok).toBe(true);
  expect((await tool(page, "gbk_list_tracks")).data.some((t: any) => t.name === "Alto counterpoint")).toBe(true);
  await tool(page, "gbk_undo");
  expect((await tool(page, "gbk_list_tracks")).data.some((t: any) => t.name === "Alto counterpoint")).toBe(false);
  await tool(page, "gbk_redo");
  expect((await tool(page, "gbk_list_tracks")).data.some((t: any) => t.name === "Alto counterpoint")).toBe(true);
  await page.screenshot({ path: `${SHOTS}/gbk-ws-05-counterpoint-accepted.png` });

  // MIDI export -> reimport keeps CCs
  const [dl] = await Promise.all([page.waitForEvent("download"), tool(page, "gbk_prepare_midi_export", {})]);
  const midPath = `${SHOTS}/gbk-ws-export.mid`; await dl.saveAs(midPath);
  const re = parseSmf(readFileSync(midPath));
  const reCc11 = re.ccs.filter((c) => c.controller === 11 && c.value === 120).length;
  expect(reCc11).toBeGreaterThan(0);
  expect(re.tracks.some((t) => t.name === "Alto counterpoint")).toBe(true);

  // WAV export (offline SF2 render incl. automation)
  const [wdl, wres] = await Promise.all([page.waitForEvent("download", { timeout: 240_000 }), tool(page, "gbk_prepare_wav_export", {})]);
  const wavPath = `${SHOTS}/gbk-ws-export.wav`; await wdl.saveAs(wavPath);
  console.log("wav", wres.ok, wres.data?.bytes);
  expect(readFileSync(wavPath).length).toBeGreaterThan(100_000);

  // Reload persists the edited project
  const revFinal = (await tool(page, "gbk_get_project_summary")).revision;
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(page.getByTestId("agent-toggle")).toBeChecked();
  await expect(page.getByTestId("webmcp-status")).toHaveText(/WebMCP on/);
  await expect.poll(async () => (await tool(page, "gbk_get_project_summary")).revision, { timeout: 20_000 }).toBe(revFinal);
  expect((await tool(page, "gbk_list_tracks")).data.some((t: any) => t.name === "Alto counterpoint")).toBe(true);
  await page.screenshot({ path: `${SHOTS}/gbk-ws-06-after-reload.png` });
});
