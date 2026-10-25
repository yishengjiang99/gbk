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
  // Phones open on the Tracks tab; the composer lives behind its tab there.
  await expect(page.getByTestId("workstation").or(page.getByTestId("social-app")).first()).toBeVisible();
  const tab = page.getByTestId("tab-composer"); if (await tab.isVisible() && (await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await expect(page.getByTestId("composer-login")).toBeVisible();
  await page.getByLabel("Access code").fill(code); await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("composer-conn")).toHaveAttribute("data-state", "connected", { timeout: 30_000 });
}

test("compose a fugue through the server agent, render a valid WAV, follow-up edit, share + fork", async ({ page, browser }) => {
  // The full flow shares one server user/conversation; run it once (desktop). Mobile has its own test below.
  test.skip(test.info().project.name !== "chrome-no-webmcp", "full flow runs on desktop Chrome only");
  mkdirSync(SHOTS, { recursive: true });
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.goto("/");
  expect(await page.evaluate(() => [!!(document as any).modelContext, !!(navigator as any).modelContext])).toEqual([false, false]);
  await expect(page.getByTestId("social-app")).toBeVisible();
  await page.getByTestId("tab-create").click();
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
  // auto-saved PRIVATE + Publish dialog offered with an AI-suggested title; keep it private for now
  await expect(page.getByTestId("publish-dialog")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("publish-title")).toHaveValue("Midnight Fugue in D Minor", { timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/composer-e2e-publish-dialog.png` });
  await page.getByTestId("publish-cancel").click();
  await page.getByTestId("my-songs-studio").locator("summary").click();
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
  const top = page.getByTestId("feed-card").first();
  await expect(top.getByTestId("card-pianoroll")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/composer-e2e-explore.png` });
  await anon.close();
});

test("mobile viewport: explore + composer panel usable", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("social-app")).toBeVisible();
  await page.getByTestId("tab-create").click();
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
  const roll = p.getByTestId("piano-roll"); await expect(roll).toBeVisible();
  const b = (await roll.boundingBox())!;
  await roll.tap({ position: { x: b.width / 2, y: b.height / 2 } });
  await roll.click({ position: { x: b.width / 3, y: b.height / 3 } });
  await roll.dblclick({ position: { x: b.width / 4, y: b.height / 2 } });
  await roll.focus(); await p.keyboard.press("Delete");
  await expect(p.getByTestId("readonly-hint")).toBeVisible();
  const after = await ws(p);
  expect(after.notes).toBe(before.notes); expect(after.revision).toBe(before.revision);
  await p.getByTestId("ws-play").first().click();
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

test("theme: landing background is uniform full height; Keys track picker is dark", async ({ page }) => {
  await page.goto("/"); await expect(page.getByTestId("social-app")).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.querySelector(".so-app")!).backgroundColor)).toBe("rgb(238, 243, 247)");
  await page.goto("/studio"); await expect(page.getByTestId("workstation")).toBeVisible();
  // The track picker only renders when the project has a track (a fresh phone session can start empty).
  await page.evaluate(() => { const c = (globalThis as any).__gbkWorkstation; if (!c.project.tracks.length) c.edit([{ op: "addTrack", name: "Piano", channel: 0, id: "t_keys", program: 0 }], { label: "seed" }); });
  await page.getByTestId("keys-toggle").click();
  const sel = page.getByTestId("live-track"); await expect(sel).toBeVisible({ timeout: 60_000 });
  expect(await sel.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe("rgb(26, 32, 41)");
  await page.getByTestId("live-keyboard").screenshot({ path: `${SHOTS}/keys-track-picker.png` });
});

test("studio fits the viewport: no vertical scrolling of the page or any panel", async ({ page }) => {
  for (const [w, h] of [[1280, 800], [1440, 900], [1920, 1080], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/studio"); await expect(page.getByTestId("workstation")).toBeVisible();
    await page.getByTestId("keys-toggle").click(); await expect(page.getByTestId("live-keyboard")).toBeVisible();
    for (const t of ["tracks", "composer", "agent", "sound", "files"]) {
      const tab = page.getByTestId(`tab-${t}`); if (await tab.count()) await tab.dispatchEvent("click"); // the floating Keys window may sit over the tabs
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))))); // roll re-measures after the full-height Composer view hid it
      const r = await page.evaluate(() => {
        const bad: string[] = [];
        for (const e of document.querySelectorAll(".ws, .ws *")) {
          if (e.closest("[hidden]") || e.tagName === "TEXTAREA" || e.tagName === "SELECT") continue;
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
  await page.getByTestId("keys-toggle").click();
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
  await page.getByTestId("keys-toggle").click(); const b3 = (await win.boundingBox())!;
  expect(Math.abs(b3.x - b2.x)).toBeLessThan(2); expect(Math.abs(b3.y - b2.y)).toBeLessThan(2);
  await page.getByTestId("keys-window-min").click(); await expect(page.getByTestId("live-keyboard")).toHaveCount(0);
  await page.getByTestId("keys-window-close").click(); await expect(win).toHaveCount(0);
});

test("guest: New project -> + Track -> click piano roll adds a note -> Play plays", async ({ page }) => {
  test.skip(test.info().project.name !== "chrome-no-webmcp" && test.info().project.name !== "mobile", "desktop Chrome + mobile");
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/studio"); await expect(page.getByTestId("workstation")).toBeVisible();
  page.on("dialog", (d) => d.accept());
  await page.getByTestId("new-project").click();
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

test("mobile composer view fits the viewport width (no horizontal scroll)", async ({ page }) => {
  test.skip(!test.info().project.name.startsWith("mobile"), "phone layout");
  await page.goto("/studio"); await signIn(page);
  for (const [w, h] of [[390, 844], [375, 667], [430, 932]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/studio");
    await expect(page.getByTestId("workstation")).toBeVisible();
    await page.evaluate(() => { const c = (globalThis as any).__gbkWorkstation; if (!c.project.tracks.length) c.edit([{ op: "addTrack", name: "Strings", channel: 0, id: "t_str", program: 48 }], { label: "seed" }); });
    // Lanes live on the roll (Tracks tab); the Composer tab then takes the full height (roll hidden).
    await page.getByTestId("tab-tracks").click();
    for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "+ lane" }).click();
    await expect(page.locator(".ws-lane").first()).toBeVisible();
    await page.getByTestId("tab-composer").click();
    await expect(page.getByTestId("composer-panel")).toBeVisible();
    await expect(page.getByTestId("composer-input")).toBeVisible();
    for (const t of ["tracks", "composer", "agent", "sound", "files"]) { const b = (await page.getByTestId(`tab-${t}`).boundingBox())!; expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(w + 0.5); }
    const m = await page.evaluate(() => {
      const W = innerWidth;
      // an element "escapes" if it extends past the viewport and no ancestor (inside the viewport) clips it
      const bad = [...document.querySelectorAll(".ws *")].filter((e) => { const r = e.getBoundingClientRect(); if (!r.width || r.right <= W + 0.5) return false;
        for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o !== "visible" && a.getBoundingClientRect().right <= W + 0.5) return false; } return true; })
        .map((e) => `${e.tagName}.${e.className}`);
      // iOS Safari auto-zooms (and stays zoomed, overflowing the width) when a focused control's font is < 16px
      const small = [...document.querySelectorAll(".ws input, .ws select, .ws textarea")].filter((e) => (e as HTMLElement).offsetParent && parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => e.getAttribute("aria-label") ?? e.tagName);
      return { sw: document.documentElement.scrollWidth, W, bad, small };
    });
    if (w === 390) await page.screenshot({ path: `${SHOTS}/composer-mobile-${test.info().project.name}.png` });
    expect(m.bad, `${w}x${h}`).toEqual([]);
    expect(m.small, `${w}x${h} controls under 16px`).toEqual([]);
    expect(m.sw).toBeLessThanOrEqual(m.W);
  }
});

test("mobile composer view fills the screen height; other tabs restore the roll", async ({ page }) => {
  test.skip(!test.info().project.name.startsWith("mobile"), "phone layout");
  await page.goto("/studio"); await signIn(page);
  await page.goto("/studio");
  await expect(page.getByTestId("workstation")).toBeVisible();
  await page.evaluate(() => { const c = (globalThis as any).__gbkWorkstation; if (!c.project.tracks.length) c.edit([{ op: "addTrack", name: "Strings", channel: 0, id: "t_str", program: 48 }], { label: "seed" }); });
  await page.getByTestId("tab-composer").click();
  const panel = page.getByTestId("composer-panel"); await expect(panel).toBeVisible();
  await expect(page.locator(".ws-main")).toBeHidden();
  const H = page.viewportSize()!.height, W = page.viewportSize()!.width;
  const tr = (await page.getByTestId("transport-row").boundingBox())!;
  const pb = (await panel.boundingBox())!; const ib = (await page.getByTestId("composer-input").boundingBox())!;
  expect(pb.y).toBeGreaterThanOrEqual(tr.y + tr.height - 1);
  expect(pb.y + pb.height).toBeGreaterThan(H - 2);   // panel reaches the bottom of the screen
  expect(pb.height).toBeGreaterThan(H * 0.55);       // most of the screen, not a 32% strip
  expect(ib.y + ib.height).toBeGreaterThan(H - 70);  // input pill pinned at the bottom
  expect(ib.y + ib.height).toBeLessThanOrEqual(H + 0.5);
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, fs: parseFloat(getComputedStyle(document.querySelector("[data-testid=composer-input] textarea, textarea[data-testid=composer-input]") as Element).fontSize), ov: getComputedStyle(document.querySelector(".cmp-messages")!).overflowY }));
  expect(m.sw).toBeLessThanOrEqual(W); expect(m.sh).toBeLessThanOrEqual(H + 0.5); expect(m.fs).toBeGreaterThanOrEqual(16); expect(m.ov).toBe("auto");
  if (test.info().project.name === "mobile-webkit") await page.screenshot({ path: `${SHOTS}/composer-fullheight.png` });
  await page.getByTestId("tab-tracks").click();
  await expect(page.locator(".ws-main")).toBeVisible();
  await expect(page.locator(".ws-roll-slot")).toBeVisible();
});
