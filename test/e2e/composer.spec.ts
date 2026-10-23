// End-to-end: ordinary browser (no WebMCP) -> AI Composer panel -> real server agent loop (fake OpenAI-compatible
// model returning real tool_calls) -> authenticated WebSocket bridge -> real gbk_* tools in the real workstation.
import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { parseWavHeader, validateWav } from "../../src/audio/audio-validation.ts";

const SHOTS = process.env.GBK_SHOTS ?? "/workspace/shots";
const PROMPT = "Compose a four-voice Baroque fugue in D minor with expressive strings, add CC11 dynamics, and render it to WAV.";
const ws = (page: Page) => page.evaluate(() => { const c = (globalThis as any).__gbkWorkstation; const p = c.project; return { id: p.id, name: p.name, owner: p.meta?.owner, tracks: p.tracks.map((t: any) => t.name), programs: p.programs.map((g: any) => g.program), notes: p.notes.length, cc11: p.ccs.filter((e: any) => e.controller === 11).length, cc1: p.ccs.filter((e: any) => e.controller === 1).length, effects: p.sound?.effects ?? null, voice: p.sound?.tracks ?? {}, revision: p.revision, readOnly: c.readOnlyReason }; });

async function signIn(page: Page, code = "e2e-code") {
  await expect(page.getByTestId("composer-login")).toBeVisible();
  await page.getByLabel("Access code").fill(code); await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("composer-conn")).toHaveAttribute("data-state", "connected", { timeout: 30_000 });
}

test("compose a fugue through the server agent, render a valid WAV, follow-up edit, share + fork", async ({ page, browser }) => {
  mkdirSync(SHOTS, { recursive: true });
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.goto("/");
  expect(await page.evaluate(() => [!!(document as any).modelContext, !!(navigator as any).modelContext])).toEqual([false, false]);
  await expect(page.getByTestId("explore-page")).toBeVisible();
  await page.getByTestId("compose-cta").click();
  await expect(page).toHaveURL(/\/studio$/);
  await expect(page.getByTestId("workstation")).toBeVisible();
  await signIn(page);
  await expect(page.getByTestId("starter-prompts")).toBeVisible();

  const t0 = Date.now();
  await page.getByTestId("composer-input").fill(PROMPT);
  await page.getByTestId("composer-input").press("Enter");
  await expect(page.getByTestId("composer-run")).toBeVisible();
  await expect(page.getByTestId("composer-stop")).toBeVisible();
  // live: the piano roll gets notes before the run finishes
  await expect.poll(async () => (await ws(page)).notes, { timeout: 120_000 }).toBeGreaterThan(400);
  const text = page.getByTestId("assistant-text").last();
  await expect(text).toContainText("Rendered WAV artifact", { timeout: 540_000 });
  console.log("compose run ms", Date.now() - t0);

  const s = await ws(page);
  console.log("project", JSON.stringify({ ...s, voice: undefined }));
  expect(s.name).toBe("Fugue in D minor"); expect(s.owner).toBe("agent");
  expect(s.tracks.length).toBe(4); expect(s.programs).toEqual(expect.arrayContaining([40, 41, 42, 6]));
  expect(s.cc11).toBeGreaterThan(20); expect(s.effects?.roomSize).toBeCloseTo(0.82);
  const steps = await page.locator('[data-testid="composer-steps"] li').evaluateAll((ls) => ls.map((l) => [l.getAttribute("data-tool"), l.getAttribute("data-status")]));
  expect(steps.map((x) => x[0])).toEqual(["gbk_get_capabilities", "gbk_create_project", "gbk_generate_arrangement", "gbk_list_tracks", "gbk_set_instrument", "gbk_set_instrument", "gbk_set_instrument", "gbk_set_instrument", "gbk_generate_cc_curve", "gbk_commit_proposal", "gbk_set_effects", "gbk_commit_proposal", "gbk_render_wav", "gbk_get_render_artifact"]);
  expect(steps.every((x) => x[1] === "done")).toBe(true);
  // piano roll + CC lane reflect the controller state
  await expect(page.getByTestId("piano-roll")).toBeVisible();
  await expect(page.getByTestId("lane-11")).toBeVisible();
  // artifact shown in the Composer, referenced by the final reply
  const art = page.getByTestId("composer-artifact").first();
  await expect(art).toBeVisible();
  const artifactId = (await art.getAttribute("data-artifact-id"))!;
  await expect(text).toContainText(artifactId);
  const wavB64 = await page.evaluate(async () => { const a = document.querySelector('[data-testid="composer-artifact"] audio') as HTMLAudioElement; const b = new Uint8Array(await (await fetch(a.src)).arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); });
  const wav = Buffer.from(wavB64, "base64");
  writeFileSync(`${SHOTS}/composer-e2e-fugue.wav`, wav);
  const h = parseWavHeader(new Uint8Array(wav));
  expect([h.container, h.sampleRate, h.channels, h.bitsPerSample]).toEqual(["RIFF", 44100, 2, 16]);
  const v = await validateWav(new Uint8Array(wav), { sampleRate: 44100, channels: 2 });
  expect(v.stats.peakDbFS).toBeGreaterThan(-30); expect(v.stats.clippedSamples).toBe(0);
  expect(h.durationSeconds).toBeGreaterThan(60);
  console.log("wav", JSON.stringify({ bytes: wav.length, sha256: createHash("sha256").update(wav).digest("hex"), durationSeconds: h.durationSeconds, peakDbFS: v.stats.peakDbFS, rmsDbFS: v.stats.rmsDbFS }));
  await page.screenshot({ path: `${SHOTS}/composer-e2e-panel.png`, fullPage: false });

  // follow-up edit on the SAME project, no regeneration
  const before = await ws(page);
  await page.getByTestId("composer-input").fill("Make the cello darker and reduce the reverb.");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("assistant-text").last()).toContainText("cello is darker", { timeout: 120_000 });
  const after = await ws(page);
  expect(after.id).toBe(before.id); expect(after.notes).toBe(before.notes);
  expect(after.effects?.reverbLevel).toBeCloseTo(0.3);
  expect(JSON.stringify(after.voice)).toMatch(/"gen":8|filterCutoff|"value"/);
  await page.screenshot({ path: `${SHOTS}/composer-e2e-followup.png` });

  // share -> anonymous viewer opens the link (read-only, new local project) -> fork
  await page.getByTestId("share-btn").click();
  const link = await page.getByTestId("share-link").locator("a").getAttribute("href");
  expect(link).toMatch(/\/s\/[a-z0-9]{8}$/);
  const anon = await browser.newContext(); const v2 = await anon.newPage();
  await v2.goto("/");
  await expect(v2.getByTestId("share-card").first()).toBeVisible();
  await expect(v2.getByTestId("share-card").first().getByTestId("card-audio")).toBeVisible(); // shared WAV preview
  await v2.goto(new URL(link!).pathname);
  await expect(v2.getByTestId("readonly-banner")).toBeVisible({ timeout: 30_000 });
  const shared = await ws(v2);
  expect(shared.readOnly).toBeTruthy(); expect(shared.notes).toBe(after.notes); expect(shared.id).not.toBe(after.id);
  await v2.getByTestId("fork-btn").click();
  await expect(v2.getByTestId("forked-from")).toBeVisible();
  expect((await ws(v2)).readOnly).toBeNull();
  await v2.screenshot({ path: `${SHOTS}/composer-e2e-forked.png` });
  await page.goto("/"); await expect(page.getByTestId("share-card").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/composer-e2e-explore.png` });
  await anon.close();
});

test("mobile viewport: explore + composer panel usable", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("explore-page")).toBeVisible();
  await page.getByTestId("compose-cta").click();
  await signIn(page, "e2e-code-2");
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/composer-e2e-mobile.png` });
});

test("smoke: page + composer connect in other engines", async ({ page }) => {
  await page.goto("/studio");
  await expect(page.getByTestId("workstation")).toBeVisible();
  await signIn(page, "e2e-code-2");
});
