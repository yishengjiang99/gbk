import { composerConn, studioReveal } from "./app-menu";
// End-to-end: ordinary browser (no WebMCP) -> AI Composer panel -> real server agent loop (fake OpenAI-compatible
// model returning real tool_calls) -> authenticated WebSocket bridge -> real gbk_* tools in the real workstation.
import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { parseWavHeader, validateWav } from "../../src/audio/audio-validation.ts";

const SHOTS = process.env.GBK_SHOTS ?? "/workspace/shots";
mkdirSync(SHOTS, { recursive: true });
const PROMPT = "Compose a four-voice Baroque fugue in D minor with expressive strings, add CC11 dynamics, and render it to WAV.";
const ws = (page: Page) => page.evaluate(() => { const c = (globalThis as any).__gbkWorkstation; const p = c.project; return { id: p.id, name: p.name, owner: p.meta?.owner, tracks: p.tracks.map((t: any) => t.name), programs: p.programs.map((g: any) => g.program), notes: p.notes.length, cc11: p.ccs.filter((e: any) => e.controller === 11).length, cc1: p.ccs.filter((e: any) => e.controller === 1).length, effects: p.sound?.effects ?? null, voice: p.sound?.tracks ?? {}, revision: p.revision, readOnly: c.readOnlyReason }; });

async function signIn(page: Page, code = "e2e-code") {
  // No standalone Sign in button: open the sign-in sheet the way a gated action does, then use the invite-code path.
  await expect(page.getByTestId("workstation").or(page.getByTestId("social-app")).first()).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("gbk:need-signin", { detail: { why: "Sign in", pending: null } })));
  await expect(page.getByTestId("signin-sheet")).toBeVisible();
  await page.getByTestId("signin-code").fill(code); await page.getByTestId("signin-code-submit").click();
  await expect(page.getByTestId("signin-sheet")).toBeHidden({ timeout: 15_000 });
  // Phones open on the Tracks tab after the reload; the composer lives behind its tab there.
  await expect(page.getByTestId("workstation").or(page.getByTestId("social-app")).first()).toBeVisible();
  const tab = page.getByTestId("tab-composer"); if (await tab.isVisible() && (await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await expect(composerConn(page)).toHaveAttribute("data-state", "connected", { timeout: 30_000 });
}

/** The landing paywall greets a fresh signed-in user ~1 s after load and covers the Studio. Dismiss it
 * when it appears so compose flows can proceed; the dismissal starts the server-side 24 h cooldown,
 * which also means no composition-triggered soft paywall appears later in the flow. */
async function dismissLandingPaywall(page: Page) {
  const modal = page.getByTestId("paywall-modal");
  try { await expect(modal).toBeVisible({ timeout: 10_000 }); } catch { return; }
  await page.getByTestId("paywall-later").click();
  await expect(modal).toHaveCount(0);
}

test("compose a fugue through the server agent, render a valid WAV, follow-up edit, share + fork", async ({ page, browser }) => {
  // The full flow shares one server user/conversation; run it once (desktop). Mobile has its own test below.
  test.skip(test.info().project.name !== "chrome-no-webmcp", "full flow runs on desktop Chrome only");
  mkdirSync(SHOTS, { recursive: true });
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.goto("/");
  expect(await page.evaluate(() => [!!(document as any).modelContext, !!(navigator as any).modelContext])).toEqual([false, false]);
  await expect(page.getByTestId("social-app")).toBeVisible();
  await (await studioReveal(page, "tab-create")).click();
  await expect(page).toHaveURL(/\/studio$/);
  await expect(page.getByTestId("workstation")).toBeVisible();
  await signIn(page);
  await dismissLandingPaywall(page);
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
  // auto-saved PRIVATE + Publish dialog offered with an AI-suggested title; keep it private for now
  await expect(page.getByTestId("publish-dialog")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("publish-title")).toHaveValue("Midnight Fugue in D Minor", { timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/composer-e2e-publish-dialog.png` });
  await page.getByTestId("publish-cancel").click();
  const mySongs = await studioReveal(page, "my-songs-studio"); if ((await mySongs.getAttribute("open")) === null) await mySongs.locator("summary").click();
  await expect(page.getByTestId("my-song").first()).toHaveAttribute("data-public", "0");
  const privSlug = await page.getByTestId("my-song").first().getAttribute("data-slug");
  const anon0 = await browser.newContext(); const a0 = await anon0.newPage();
  expect((await a0.request.get(`/api/shares/${privSlug}`)).status()).toBe(404);
  expect(((await (await a0.request.get(`/api/shares`)).json()).shares as { slug: string }[]).some((x) => x.slug === privSlug)).toBe(false);
  await anon0.close();
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

  // The landing paywall was dismissed right after sign-in, so this user is inside the 24 h dismiss
  // cooldown: the follow-up (their 2nd composition) raises NO soft paywall, and the publish offer below
  // is not gated by a paywall decision. (Before the landing trigger, this beat asserted the
  // second_composition modal; the trigger itself is covered by the dedicated paywall test + unit tests.)
  await page.waitForTimeout(3_000); // let the run-completed eligibility check settle
  await expect(page.getByTestId("paywall-modal")).toHaveCount(0);

  // the follow-up run finished: Publish dialog again -> edit the suggested title -> confirm (the only way to go public)
  await expect(page.getByTestId("publish-dialog")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("publish-title")).toHaveValue("Midnight Fugue in D Minor", { timeout: 15_000 });
  await page.getByTestId("publish-title").fill("Midnight Fugue in D Minor (dark cello)");
  await page.getByTestId("publish-confirm").click();
  await expect(page.getByTestId("publish-dialog")).toBeHidden();
  const link = await page.getByTestId("share-link").locator("a").getAttribute("href");
  expect(link).toMatch(/\/s\/midnight-fugue-in-d-minor-dark-cello-[a-z0-9]{8}$/); expect(link).toContain(privSlug!.slice(-8));
  const anon = await browser.newContext(); const v2 = await anon.newPage();
  await v2.goto("/");
  await v2.getByTestId("chip-new").click();
  await expect(v2.getByTestId("feed-card").first()).toBeVisible();
  await expect(v2.getByTestId("feed-card").first()).toContainText("Midnight Fugue in D Minor (dark cello)");
  expect(await v2.getByTestId("my-songs").count()).toBe(0); // logged out: no My songs
  await expect(v2.getByTestId("feed-card").first().getByTestId("card-play")).toBeVisible(); // shared audio preview
  await v2.goto(new URL(link!).pathname);
  await expect(v2.getByTestId("readonly-banner")).toBeVisible({ timeout: 30_000 });
  const shared = await ws(v2);
  expect(shared.readOnly).toBeTruthy(); expect(shared.notes).toBe(after.notes); expect(shared.id).not.toBe(after.id);
  await v2.getByTestId("fork-btn").click();
  await expect(v2.getByTestId("forked-from")).toBeVisible();
  expect((await ws(v2)).readOnly).toBeNull();
  await v2.screenshot({ path: `${SHOTS}/composer-e2e-forked.png` });
  await page.goto("/"); await expect(page.getByTestId("feed-card").first()).toBeVisible();
  const top = page.getByTestId("feed-card").filter({ hasText: "Midnight Fugue" }).first(); // For you is personalized: find our song, not "the top card"
  await expect(top.getByTestId("card-pianoroll")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/composer-e2e-explore.png` });
  await anon.close();
});

test("mobile viewport: explore + composer panel usable", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("social-app")).toBeVisible();
  await (await studioReveal(page, "tab-create")).click();
  await signIn(page, "e2e-code-2");
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/composer-e2e-mobile.png` });
});

test("smoke: page + composer connect in other engines", async ({ page }) => {
  await page.goto("/studio");
  await expect(page.getByTestId("workstation")).toBeVisible();
  await signIn(page, "e2e-code-2");
});

// Regression (client_errors, iPhone Safari): tapping the piano roll on a read-only share threw an uncaught
// READ_ONLY error from assertWritable. Edits must be no-ops with a gentle hint; Play must still work.
test("read-only share: piano-roll tap does not throw or report an error; Play works", async ({ browser }) => {
  test.skip(test.info().project.name !== "chrome-no-webmcp", "desktop Chrome only");
  const { readFileSync } = await import("node:fs");
  const proj = JSON.parse(readFileSync("songs/2026-10-23-midnight-invention/project.json", "utf8"));
  const owner = await browser.newContext(); const op = await owner.newPage();
  await op.goto("/studio");
  const slug = await op.evaluate(async ({ proj }) => {
    const j = async (r: Response) => { if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); return r.json(); };
    const s = await j(await fetch("/api/session", { credentials: "same-origin" }));
    const l = await j(await fetch("/api/login", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-gbk-csrf": s.csrf }, body: JSON.stringify({ code: "e2e-code-2" }) }));
    const r = await j(await fetch("/api/shares", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-gbk-csrf": l.csrf }, body: JSON.stringify({ title: "Read-only tap", project: proj, public: true }) }));
    return r.slug as string;
  }, { proj });
  await owner.close();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true }); const p = await ctx.newPage();
  const errors: string[] = []; p.on("pageerror", (e) => errors.push(e.message));
  const reports: string[] = []; p.on("request", (r) => { if (/client-?errors?/i.test(r.url())) reports.push(r.url()); });
  await p.goto(`/s/${slug}`);
  await expect.poll(async () => (await ws(p)).readOnly, { timeout: 20_000 }).toBeTruthy();
  const before = await ws(p);
  if (await p.getByTestId("plus-btn").count()) await p.getByTestId("version-open-editor").last().click(); // phone studio: the roll is in the editor sheet
  const roll = p.getByTestId("piano-roll"); await expect(roll).toBeVisible();
  const b = (await roll.boundingBox())!;
  await roll.tap({ position: { x: b.width / 2, y: b.height / 2 } });
  await roll.click({ position: { x: b.width / 3, y: b.height / 3 } });
  await roll.dblclick({ position: { x: b.width / 4, y: b.height / 2 } });
  await roll.focus(); await p.keyboard.press("Delete");
  await expect(p.getByTestId("readonly-hint")).toBeVisible();
  const after = await ws(p);
  expect(after.notes).toBe(before.notes); expect(after.revision).toBe(before.revision);
  await p.getByTestId("ws-play").or(p.getByTestId("play-pill")).first().click({ timeout: 60_000 });
  await expect.poll(() => p.evaluate(() => (globalThis as any).__gbkWorkstation.state.transport.playing), { timeout: 10_000 }).toBe(true);
  await p.waitForTimeout(500);
  expect(errors).toEqual([]); expect(reports).toEqual([]);
  await ctx.close();
});

// Regression: a /s/<slug> link must show exactly that song, even though the player's startup default song
// (Beethoven) and the autosave restore race it. Previously the startup song replaced the share in fresh profiles.
test("share link always opens the shared song (startup default/restore must not win)", async ({ browser, baseURL }) => {
  test.skip(test.info().project.name !== "chrome-no-webmcp", "desktop Chrome only");
  const { readFileSync } = await import("node:fs");
  const proj = JSON.parse(readFileSync("songs/2026-10-23-midnight-invention/project.json", "utf8"));
  const owner = await browser.newContext(); const op = await owner.newPage();
  await op.goto("/studio");
  const slug = await op.evaluate(async ({ proj }) => {
    const j = async (r: Response) => { if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); return r.json(); };
    const s = await j(await fetch("/api/session", { credentials: "same-origin" }));
    const l = await j(await fetch("/api/login", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-gbk-csrf": s.csrf }, body: JSON.stringify({ code: "e2e-code-2" }) }));
    const r = await j(await fetch("/api/shares", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-gbk-csrf": l.csrf }, body: JSON.stringify({ title: "Midnight Invention", project: proj, public: true }) })); // shares are private unless public
    return r.slug as string;
  }, { proj });
  await owner.close();
  for (const warm of [false, true]) {
    const ctx = await browser.newContext(); const p = await ctx.newPage();
    if (warm) { await p.goto("/studio"); await expect(p.getByTestId("workstation")).toBeVisible(); await p.waitForTimeout(3_000); } // whatever the studio starts with (empty or a default song) is loaded + autosaved first
    await p.goto(`/s/${slug}`);
    await expect.poll(async () => (await ws(p)).name, { timeout: 20_000 }).toBe("Midnight Invention");
    await p.waitForTimeout(10_000); // give the player's startup song load every chance to clobber it
    const st = await ws(p);
    expect(st.name).toBe("Midnight Invention"); expect(st.notes).toBe(proj.notes.length); expect(st.readOnly).toBeTruthy();
    await ctx.close();
  }
});

test("theme: landing background is uniform full height; Keys track picker follows the bright theme", async ({ page }) => {
  await page.goto("/"); await expect(page.getByTestId("social-app")).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.querySelector(".so-app")!).backgroundColor)).toBe("rgb(238, 243, 247)");
  await page.goto("/studio"); await expect(page.getByTestId("workstation")).toBeVisible();
  // The track picker only renders when the project has a track (a fresh phone session can start empty).
  await page.evaluate(() => { const c = (globalThis as any).__gbkWorkstation; if (!c.project.tracks.length) c.edit([{ op: "addTrack", name: "Piano", channel: 0, id: "t_keys", program: 0 }], { label: "seed" }); });
  await (await studioReveal(page, "keys-toggle")).click();
  const sel = page.getByTestId("live-track"); await expect(sel).toBeVisible({ timeout: 60_000 });
  // bright theme by default on phones and the desktop studio grid alike (card colour in the MIDI keyboard picker)
  expect(await sel.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe("rgb(244, 245, 247)");
  await page.getByTestId("live-keyboard").screenshot({ path: `${SHOTS}/keys-track-picker.png` });
});

test("studio fits the viewport: no vertical scrolling of the page or any panel", async ({ page }) => {
  for (const [w, h] of [[1280, 800], [1440, 900], [1920, 1080], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/studio"); await expect(page.getByTestId("workstation")).toBeVisible();
    await (await studioReveal(page, "keys-toggle")).click(); await expect(page.getByTestId("live-keyboard")).toBeVisible();
    for (const t of ["tracks", "composer", "agent", "sound", "files"]) {
      const tab = await studioReveal(page, `tab-${t}`); if (await tab.count()) await tab.dispatchEvent("click"); // the floating Keys window may sit over the tabs
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))); // roll re-measures after the full-height Composer view hid it
      const r = await page.evaluate(() => {
        const bad: string[] = [];
        for (const e of document.querySelectorAll(".ws, .ws *")) {
          if (e.closest("[hidden]") || e.closest("[data-scroll-ok]") || e.tagName === "TEXTAREA" || e.tagName === "SELECT") continue; // desktop grid: track list, patch browser and chat log scroll by design
          const c = getComputedStyle(e);
          if (c.overflowY !== "visible" && e.scrollHeight > e.clientHeight + 2 && e.clientHeight > 0) bad.push(`${e.tagName}.${e.className} ${e.scrollHeight}/${e.clientHeight}`);
        }
        return { doc: document.scrollingElement!.scrollHeight, inner: innerHeight, bad };
      });
      expect(r.doc, `${w}x${h} ${t}: page`).toBeLessThanOrEqual(r.inner);
      expect(r.bad, `${w}x${h} ${t}: panels`).toEqual([]);
    }
    await page.mouse.wheel(0, 2000); expect(await page.evaluate(() => scrollY)).toBe(0);
  }
});

test("feed landing fits the viewport: no page scroll, no horizontal overflow; studio-fit only in studio", async ({ page }) => {
  for (const [w, h] of [[1280, 480], [390, 560]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/"); await expect(page.getByTestId("social-app")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.classList.contains("studio-fit"))).toBe(false);
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(w);
    await expect(page.getByTestId("tabs")).toBeInViewport();
  }
  await page.goto("/studio"); await expect(page.getByTestId("workstation")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.classList.contains("studio-fit"))).toBe(true);
});

test("Keys is a floating draggable window: default closed, opens, drags, closes", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/studio"); await page.evaluate(() => localStorage.removeItem("gbk.keysWindowPos")); await page.reload();
  await expect(page.getByTestId("workstation")).toBeVisible();
  await expect(page.getByTestId("keys-window")).toHaveCount(0);
  const rollBefore = (await page.getByTestId("piano-roll").boundingBox())!.height;
  await (await studioReveal(page, "keys-toggle")).click();
  const win = page.getByTestId("keys-window"); await expect(win).toBeVisible(); await expect(page.getByTestId("live-keyboard")).toBeVisible();
  expect((await page.getByTestId("piano-roll").boundingBox())!.height).toBe(rollBefore); // floats: no layout space
  expect(await page.evaluate(() => document.scrollingElement!.scrollHeight <= innerHeight)).toBe(true);
  const b0 = (await win.boundingBox())!; const hb = (await page.getByTestId("keys-window-handle").boundingBox())!;
  await page.mouse.move(hb.x + 40, hb.y + hb.height / 2); await page.mouse.down();
  await page.mouse.move(hb.x - 200, hb.y - 300, { steps: 8 }); await page.mouse.up();
  const b1 = (await win.boundingBox())!;
  expect(b1.x).toBeLessThan(b0.x - 100); expect(b1.y).toBeLessThan(b0.y - 100);
  // clamped to the viewport
  await page.mouse.move(b1.x + 40, b1.y + 10); await page.mouse.down(); await page.mouse.move(-500, -500, { steps: 5 }); await page.mouse.up();
  const b2 = (await win.boundingBox())!; expect(b2.x).toBeGreaterThanOrEqual(0); expect(b2.y).toBeGreaterThanOrEqual(0);
  // position remembered
  await page.getByTestId("keys-window-close").click(); await expect(win).toHaveCount(0);
  await (await studioReveal(page, "keys-toggle")).click(); const b3 = (await win.boundingBox())!;
  expect(Math.abs(b3.x - b2.x)).toBeLessThan(2); expect(Math.abs(b3.y - b2.y)).toBeLessThan(2);
  await page.getByTestId("keys-window-min").click(); await expect(page.getByTestId("live-keyboard")).toHaveCount(0);
  await page.getByTestId("keys-window-close").click(); await expect(win).toHaveCount(0);
});

test("guest: New project -> + Track -> click piano roll adds a note -> Play plays", async ({ page }) => {
  test.skip(test.info().project.name !== "chrome-no-webmcp", "desktop Chrome (the phone studio has its own test below)");
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/studio"); await expect(page.getByTestId("workstation")).toBeVisible();
  page.on("dialog", (d) => d.accept());
  await (await studioReveal(page, "new-project")).click();
  await expect.poll(async () => (await ws(page)).tracks.length).toBe(0);
  await expect(page.getByTestId("roll-empty")).toBeVisible();
  await page.getByTestId("roll-add-track").click();
  const inst = page.getByTestId("add-track-instrument"); await expect(inst).toBeVisible();
  await expect(inst).toHaveValue("0"); await expect(inst.locator("option:checked")).toContainText(/piano/i);
  await expect.poll(() => inst.locator("option").count(), { timeout: 60_000 }).toBeGreaterThan(100); // GM list from the SoundFont
  await page.getByTestId("add-track-confirm").click();
  await expect.poll(async () => (await ws(page)).tracks.length).toBe(1);
  const s = await ws(page); expect(s.programs).toEqual([0]); expect(s.readOnly).toBeFalsy();
  await expect(page.getByTestId("roll-empty")).toHaveCount(0);
  const roll = page.getByTestId("piano-roll"); const b = (await roll.boundingBox())!;
  await roll.click({ position: { x: b.width * 0.3, y: b.height * 0.5 } });
  await expect.poll(async () => (await ws(page)).notes).toBe(1);
  await expect(page.getByTestId("ws-play").first()).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("ws-play").first().click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).__gbkWorkstation.state.transport.playing), { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => +(await page.getByTestId("ws-pos").first().getAttribute("data-pos-tick") ?? 0), { timeout: 20_000 }).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.scrollingElement!.scrollHeight <= innerHeight)).toBe(true);
  expect(errors).toEqual([]);
});

// ---- Chat-first phone studio (MobileStudio) ------------------------------------------------------------------------
const seedSong = (page: Page) => page.evaluate(() => { const c = (globalThis as any).__gbkWorkstation; if (c.project.tracks.length) return;
  c.edit([{ op: "addTrack", name: "Piano", channel: 0, id: "t_pno", program: 0 }, { op: "addNotes", notes: [60, 64, 67, 72, 67, 64, 60, 55].map((p, i) => ({ trackId: "t_pno", channel: 0, tick: i * 480, duration: 440, pitch: p, velocity: 96 })) }], { label: "seed" }); });
/** The input is on screen (inside the visual viewport), not covered by anything, 16px, and nothing overflows sideways. */
async function inputOk(page: Page, label: string) {
  const input = page.getByTestId("composer-input"); await expect(input, label).toBeVisible();
  await expect.poll(() => input.evaluate((e) => { const b = e.getBoundingClientRect(); const vv = window.visualViewport; const h = vv ? vv.height + vv.offsetTop : innerHeight;
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return [b.top >= 0, b.bottom <= h + 1, b.left >= 0, b.right <= innerWidth + 1, !!hit && (hit === e || e.contains(hit)), getComputedStyle(e).fontSize, document.documentElement.scrollWidth <= innerWidth].join(","); }), { message: label, timeout: 5000 })
    .toBe("true,true,true,true,true,16px,true");
}
/** No element pokes past the right edge unless an ancestor inside the viewport clips it. */
const escapes = (page: Page) => page.evaluate(() => { const W = innerWidth;
  return [...document.querySelectorAll("[data-testid=workstation] *")].filter((e) => { const r = e.getBoundingClientRect(); if (!r.width || r.right <= W + 0.5 || e.closest("[hidden]")) return false;
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o !== "visible" && a.getBoundingClientRect().right <= W + 0.5) return false; } return true; }).map((e) => `${e.tagName}.${e.className}`); });

test("mobile composer view: chat studio has no tab bar/rewind/scrubber, fits 375-430px in light + dark, input always visible (sheets, editor, keyboard, playback)", async ({ page }) => {
  test.skip(!test.info().project.name.startsWith("mobile"), "phone layout");
  test.setTimeout(240_000);
  const P = test.info().project.name; const shot = async (name: string, scheme: string) => { if (P === "mobile-webkit" && page.viewportSize()!.width === 390) await page.screenshot({ path: `${SHOTS}/studio-redesign-${name}-${scheme}.png` }); };
  for (const scheme of ["light", "dark"] as const) for (const [w, h] of [[390, 844], [375, 667], [430, 932]]) {
    await page.emulateMedia({ colorScheme: scheme }); await page.setViewportSize({ width: w, height: h });
    await page.goto("/studio"); const ws = page.getByTestId("workstation"); await expect(ws).toHaveAttribute("data-compact", "1");
    page.removeAllListeners("dialog"); page.on("dialog", (d) => d.accept());
    if (await page.evaluate(() => (globalThis as any).__gbkWorkstation.project.tracks.length)) { await page.getByTestId("studio-overflow").click(); await page.getByTestId("new-project").click(); }
    const lbl = `${scheme} ${w}x${h}`;
    // header: title, play pill, ＋ New, ⋯ only; none of the old desktop chrome
    const head = page.getByTestId("compact-head"); await expect(head.locator("button")).toHaveCount(4); // back to Explore, play pill, ＋ New, ⋯
    await expect(page.getByTestId("studio-back")).toBeInViewport();
    expect(await head.evaluate((e) => e.scrollWidth <= e.clientWidth && [...e.children].every((c) => c.getBoundingClientRect().right <= innerWidth + 0.5)), `${lbl} header fits`).toBe(true);
    for (const id of ["tab-tracks", "tab-composer", "tab-agent", "tab-sound", "tab-files", "scrubber", "ws-play", "keys-toggle"]) await expect(page.getByTestId(id), `${lbl} ${id}`).toBeHidden();
    await expect(page.getByRole("button", { name: /^(Rewind|Stop)$/ })).toHaveCount(0); await expect(page.getByText("Automation for")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /sign in/i })).toHaveCount(0);
    const bg = await ws.evaluate((e) => getComputedStyle(e).backgroundColor); expect(bg, lbl).toBe(scheme === "light" ? "rgb(255, 255, 255)" : "rgb(13, 15, 20)");
    await expect(page.getByTestId("studio-empty")).toBeVisible(); await inputOk(page, `${lbl} empty`); expect(await escapes(page), lbl).toEqual([]);
    await shot("empty", scheme);
    // + : exactly three options
    await page.getByTestId("plus-btn").click(); const plus = page.getByTestId("sheet-plus");
    await expect(plus.locator(".ms-row")).toHaveText([/Import sheet music/, /Import MIDI file/, /Connect MIDI keyboard/]); await inputOk(page, `${lbl} + sheet`); await shot("plus", scheme);
    await page.getByTestId("plus-midi-keyboard").click();
    if (P === "mobile-webkit") await expect(page.getByTestId("midi-unsupported")).toHaveText("MIDI keyboards need Chrome/Edge or the iOS app.");
    await inputOk(page, `${lbl} midi sheet`); await page.getByTestId("sheet-scrim").click({ position: { x: 10, y: 120 } });
    // ⋯ : the seven actions (model/tokens/account only in Settings)
    await page.getByTestId("studio-overflow").click();
    await expect(page.getByTestId("sheet-more").locator(".ms-row")).toHaveText([/Publish & share/, /Export/, /Recent projects/, /My songs/, /Rename/, /New song/, /Settings/]);
    await inputOk(page, `${lbl} ⋯ sheet`); await shot("more", scheme);
    await page.getByTestId("more-rename").click(); await expect(page.getByTestId("rename-input")).toHaveCSS("font-size", "16px");
    await page.getByTestId("rename-input").fill("Night Drive"); await page.getByTestId("rename-save").click(); await expect(page.getByTestId("studio-title")).toHaveText("Night Drive");
    // a song: card -> editor sheet (Tracks / Mixer / Sound / Automation) -> full-screen roll
    await seedSong(page); const card = page.getByTestId("version-card").last(); await expect(card).toBeVisible(); await inputOk(page, `${lbl} song`);
    await shot("song", scheme);
    await card.getByTestId("version-open-editor").click(); await expect(page.getByTestId("sheet-editor")).toBeVisible();
    for (const t of ["tracks", "mixer", "sound", "automation"]) { await page.getByTestId(`tab-${t}`).click(); await inputOk(page, `${lbl} editor ${t}`); expect(await escapes(page), `${lbl} editor ${t}`).toEqual([]); if (t === "tracks") await shot("editor", scheme); }
    await page.getByTestId("full-roll").click(); await expect(page.getByTestId("piano-roll")).toBeVisible(); await inputOk(page, `${lbl} full roll`); await shot("fullroll", scheme);
    await page.getByTestId("editor-close").click(); await expect(page.getByTestId("sheet-editor")).toBeHidden();
    // keyboard open (short visual viewport) and closed
    await page.getByTestId("composer-input").focus(); await page.setViewportSize({ width: w, height: Math.round(h * 0.55) }); await inputOk(page, `${lbl} keyboard open`);
    await page.setViewportSize({ width: w, height: h }); await page.getByTestId("composer-input").blur(); await inputOk(page, `${lbl} keyboard closed`);
    // playback: header pill shows pause + time; input stays
    const pill = page.getByTestId("play-pill"); await expect(pill).toBeEnabled({ timeout: 120_000 }); await pill.click();
    await expect(pill).toHaveAttribute("aria-label", "Pause", { timeout: 30_000 }); await expect(page.getByTestId("play-time")).toHaveText(/^\d+:\d\d$/);
    await inputOk(page, `${lbl} playing`); await shot("playing", scheme);
    await page.getByTestId("composer-input").focus(); await inputOk(page, `${lbl} playing + focused`); await page.getByTestId("composer-input").blur();
    await pill.click(); await expect(pill).toHaveAttribute("aria-label", "Play");
  }
});

test("mobile composer view: each reply is a version card; older versions play and restore (undoable); steps + Stop while composing", async ({ page }) => {
  test.skip(!test.info().project.name.startsWith("mobile"), "phone layout");
  test.setTimeout(600_000);
  const P = test.info().project.name;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/studio"); await signIn(page, "e2e-code-2");
  await dismissLandingPaywall(page);
  page.on("dialog", (d) => d.accept());
  // Right after the sign-in reload the conversation history lands and WebKit can drop a fill that races that render
  // (seen in full-suite runs: input focused but empty). Type only once the restored history is on screen, then check it took.
  await expect(page.locator("main").first()).toBeVisible();
  await expect(async () => { await page.getByTestId("composer-input").fill(PROMPT); await expect(page.getByTestId("composer-send")).toBeVisible({ timeout: 1000 }); }).toPass({ timeout: 15_000 });
  await page.getByTestId("composer-send").click();
  const steps = page.getByTestId("composer-steps"); await expect(steps).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("composer-stop")).toBeVisible(); await inputOk(page, "composing");
  await expect(steps).not.toContainText(/gbk_|_/);
  if (P === "mobile-webkit") { await page.screenshot({ path: `${SHOTS}/studio-redesign-composing-light.png` }); await page.emulateMedia({ colorScheme: "dark" }); await page.screenshot({ path: `${SHOTS}/studio-redesign-composing-dark.png` }); await page.emulateMedia({ colorScheme: "light" }); }
  await expect(page.locator("[data-testid=version-card][data-version='1']")).toBeVisible({ timeout: 480_000 });
  await expect(page.getByTestId("composer-stop")).toHaveCount(0);
  await page.getByTestId("composer-input").fill("Make the cello darker"); await page.getByTestId("composer-send").click();
  const v2 = page.locator("[data-testid=version-card][data-version='2']"); await expect(v2).toBeVisible({ timeout: 240_000 });
  await expect(v2).toHaveAttribute("data-current", "1");
  // The landing paywall was dismissed right after sign-in (24 h cooldown), so the 2nd composition raises
  // no soft paywall in the phone studio either — nothing covers the version restore below.
  await page.waitForTimeout(2_000);
  await expect(page.getByTestId("paywall-modal")).toHaveCount(0);
  const v1 = page.locator("[data-testid=version-card][data-version='1']"); await expect(v1).toHaveAttribute("data-current", "0");
  const rev = await page.evaluate(() => (globalThis as any).__gbkWorkstation.project.revision);
  await v1.getByTestId("version-restore").click(); await expect(page.getByTestId("studio-toast")).toContainText("Restored v1");
  await expect.poll(() => page.evaluate(() => (globalThis as any).__gbkWorkstation.project.revision)).toBeGreaterThan(rev);
  await page.getByTestId("toast-undo").click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).__gbkWorkstation.project.revision)).toBeGreaterThan(rev + 1);
  await expect(v2).toHaveAttribute("data-current", "0"); // undo is a new revision, shown as "latest edits"
  await inputOk(page, "after restore + undo");
  if (P === "mobile-webkit") for (const scheme of ["light", "dark"] as const) { await page.emulateMedia({ colorScheme: scheme }); await page.screenshot({ path: `${SHOTS}/studio-redesign-versions-${scheme}.png` }); }
});

test("mobile composer view: the header back button goes to Explore in one tap", async ({ page }) => {
  test.skip(!test.info().project.name.startsWith("mobile"), "phone layout");
  await page.goto("/studio"); await page.getByTestId("studio-back").click();
  await expect(page.getByTestId("social-app")).toBeVisible(); await expect(page).not.toHaveURL(/\/studio/);
});

test("mobile composer view: Bluetooth MIDI pairing offered when gbkMidiNative.bluetooth is set; MIDI file + sheet image pickers", async ({ page }) => {
  test.skip(!test.info().project.name.startsWith("mobile"), "phone layout");
  await page.addInitScript(() => { (window as any).__btOpened = 0; (window as any).gbkMidiNative = { bluetooth: true, openBluetoothPairing: () => { (window as any).__btOpened++; } }; });
  await page.goto("/studio"); await page.getByTestId("plus-btn").click(); await page.getByTestId("plus-midi-keyboard").click();
  await page.getByTestId("bt-midi").click(); expect(await page.evaluate(() => (window as any).__btOpened)).toBe(1);
  await inputOk(page, "bt");
  expect(await page.getByTestId("midi-file-input").getAttribute("accept")).toContain(".mid");
  await page.getByTestId("midi-file-input").setInputFiles(new URL("../fixtures/import-test.mid", import.meta.url).pathname);
  await expect(page.getByTestId("midi-import")).toBeVisible(); await page.getByTestId("midi-import-new").click();
  await expect(page.getByTestId("version-card")).toBeVisible();
  expect(await page.getByTestId("sheet-image-input").getAttribute("accept")).toBe("image/jpeg,image/png");
  await page.getByTestId("sheet-image-input").setInputFiles({ name: "x.png", mimeType: "image/png", buffer: Buffer.from("not an image") });
  await expect(page.getByTestId("studio-toast")).toContainText(/photo/i, { timeout: 60_000 });
  await expect(page.getByTestId("studio-toast")).not.toContainText(/[A-Z]{3,}_|Error:/);
});

test("mobile composer view: in the iOS app (gbkNative) the + sheet has two rows, no sheet-music import (native Scan bar instead)", async ({ page }) => {
  test.skip(!test.info().project.name.startsWith("mobile"), "phone layout");
  await page.addInitScript(() => { (window as any).gbkNative = { platform: "ios", version: 1, capabilities: ["hum"] }; });
  await page.goto("/studio"); await page.getByTestId("plus-btn").click();
  await expect(page.getByTestId("sheet-plus").locator(".ms-row")).toHaveText([/Import MIDI file/, /Connect MIDI keyboard/]);
  await expect(page.getByTestId("plus-sheet-music")).toHaveCount(0);
  await inputOk(page, "app + sheet");
});

// Landing paywall + #116. The modal greets a non-Pro user right after landing (reason "landing"; annual
// preselected, trial CTA, view + dismiss recorded server-side); the dismiss starts a 24 h cooldown that
// also silences the composition triggers; the hard variant still blocks on a budget failure. A dedicated
// access-code user (paywall:e2e-code-3) keeps the per-user usage counters deterministic.
test("paywall modal: landing right after sign-in, dismiss cooldown silences composition triggers, hard variant blocks", async ({ page }) => {
  test.skip(test.info().project.name !== "chrome-no-webmcp", "paywall flow runs on desktop Chrome only");
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.goto("/");
  await expect(page.getByTestId("social-app")).toBeVisible();
  await (await studioReveal(page, "tab-create")).click();
  await expect(page).toHaveURL(/\/studio$/);
  await expect(page.getByTestId("workstation")).toBeVisible();
  await signIn(page, "e2e-code-3");
  await expect(page.getByTestId("starter-prompts")).toBeVisible();

  const me = () => page.evaluate(async () => { const r = await fetch("/api/me", { credentials: "same-origin" }); return r.ok ? (await r.json()) as any : null; });
  expect((await me())?.usage?.compositions ?? 0).toBe(0);
  expect((await me())?.paywall?.reason).toBe("landing");

  // --- landing: the soft paywall greets the fresh signed-in user (the host checks once on mount).
  const modal = page.getByTestId("paywall-modal");
  await expect(modal).toBeVisible({ timeout: 30_000 });
  await expect(modal).toHaveAttribute("data-kind", "soft");
  await expect(modal).toHaveAttribute("data-reason", "landing");
  await expect(page.getByTestId("paywall-plan-pro_yearly")).toHaveClass(/sel/); // annual preselected
  await expect(page.getByTestId("paywall-cta")).toHaveText("Start 7-day free trial");
  await page.screenshot({ path: `${SHOTS}/composer-e2e-paywall-soft.png` });
  await expect.poll(async () => (await me())?.usage?.paywall_views, { timeout: 15_000 }).toBe(1); // paywall_view recorded

  // --- dismiss: modal gone, and the server recorded the dismiss (24 h cooldown in /api/me.paywall).
  await page.getByTestId("paywall-later").click();
  await expect(modal).toHaveCount(0);
  await expect.poll(async () => (await me())?.paywall?.cooldown_until ?? 0, { timeout: 15_000 }).toBeGreaterThan(Date.now());

  // --- 1st composition: counted, but no paywall (the dismiss cooldown silences every soft trigger).
  await page.getByTestId("composer-input").fill(PROMPT);
  await page.getByTestId("composer-input").press("Enter");
  await expect(page.getByTestId("assistant-text").last()).toContainText("Rendered WAV artifact", { timeout: 540_000 });
  await expect(page.getByTestId("publish-dialog")).toBeVisible({ timeout: 30_000 }); // autosave offer, as in the fugue flow
  await page.getByTestId("publish-cancel").click();
  await page.waitForTimeout(3_000); // let the run-completed eligibility check settle
  await expect(page.getByTestId("paywall-modal")).toHaveCount(0);
  expect((await me())?.usage?.compositions).toBe(1);

  // --- 2nd composition: second_composition would fire, but the cooldown keeps the modal away; the
  // publish offer still arrives (the paywall gate releases it once the decision settles).
  await page.getByTestId("composer-input").fill("Make the cello darker and reduce the reverb.");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("assistant-text").last()).toContainText("cello is darker", { timeout: 120_000 });
  await expect(page.getByTestId("publish-dialog")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("publish-cancel").click();
  await page.waitForTimeout(3_000);
  await expect(page.getByTestId("paywall-modal")).toHaveCount(0);
  expect((await me())?.usage?.compositions).toBe(2);

  // --- hard variant: a budget failure blocks with the reset time; Escape does not dismiss it.
  const budgetFail = () => page.evaluate(() => window.dispatchEvent(new CustomEvent("gbk:run-failed", { detail: { runId: "e2e-paywall", code: "TOKEN_BUDGET_EXHAUSTED", message: "budget" } })));
  // Dispatch until the host picks it up (a dispatch that lands before the listener mounts is a no-op;
  // re-dispatching while the modal is open is also a no-op, so polling this is safe).
  await expect.poll(async () => { await budgetFail(); return modal.count(); }, { timeout: 30_000 }).toBe(1);
  await expect(modal).toBeVisible();
  await expect(modal).toHaveAttribute("data-kind", "hard");
  await expect(modal).toHaveAttribute("data-reason", "ai_limit");
  await expect(page.getByTestId("paywall-reset")).toContainText("resets at");
  await page.screenshot({ path: `${SHOTS}/composer-e2e-paywall-hard.png` });
  await page.keyboard.press("Escape");
  await expect(modal).toBeVisible(); // hard modals are not Escape-dismissable
  await page.getByTestId("paywall-continue").click(); // "Continue free" closes it (dismiss recorded)
  await expect(modal).toHaveCount(0);
  await budgetFail();
  await page.waitForTimeout(2_000);
  await expect(modal).toHaveCount(0); // a dismissed hard reason stays dismissed for the session

  // --- plan_select + CTA: a fresh page session re-arms the hard gate; picking monthly fires plan_select
  // through POST /api/me/engagement and navigates to /pricing with the plan attached.
  await page.goto("/studio");
  await expect(page.getByTestId("workstation")).toBeVisible();
  await expect.poll(async () => { await budgetFail(); return modal.count(); }, { timeout: 30_000 }).toBe(1);
  await expect(modal).toBeVisible();
  await page.getByTestId("paywall-plan-pro_monthly").click();
  await expect(page.getByTestId("paywall-plan-pro_monthly")).toHaveClass(/sel/);
  const planSelect = page.waitForRequest((r) => r.url().includes("/api/me/engagement") && (r.postDataJSON() as any)?.event === "plan_select", { timeout: 15_000 });
  await page.getByTestId("paywall-cta").click();
  const body = (await planSelect).postDataJSON() as any;
  expect(body.plan).toBe("pro_monthly"); expect(body.surface).toBe("studio"); expect(body.platform).toBe("web"); expect(body.reason).toBe("ai_limit");
  await expect(page).toHaveURL(/\/pricing\?plan=pro_monthly/, { timeout: 20_000 });
});
