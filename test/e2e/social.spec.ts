import { composerConn, studioReveal } from "./app-menu";
// gbk Social e2e (Pixel, WebKit iPhone, desktop Chrome): feed cards, rating, flat comments (escaped), tag filter,
// report, profile; no horizontal overflow and 16px inputs. Seeds one public song via the API and deletes it after.
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const project = JSON.parse(readFileSync(new URL("../fixtures/social-song.json", import.meta.url), "utf8"));
/** The landing paywall greets a freshly signed-in non-Pro user ~1 s after a page load and covers the
 * app. Dismiss it when it appears so feed/studio clicks are not blocked; tolerant when it does not
 * come (guest page, Pro, or the account is inside the dismiss cooldown). */
async function dismissLandingPaywall(page: Page) {
  const modal = page.getByTestId("paywall-modal");
  try { await expect(modal).toBeVisible({ timeout: 10_000 }); } catch { return; }
  await page.getByTestId("paywall-later").click();
  await expect(modal).toHaveCount(0);
}

async function apiLogin(req: APIRequestContext, base: string, code: string) {
  const csrf = (await (await req.get("/api/session")).json()).csrf as string;
  const r = await req.post("/api/login", { headers: { origin: base, "x-gbk-csrf": csrf }, data: { code } }); expect(r.ok()).toBeTruthy();
  return { origin: base, "x-gbk-csrf": (await r.json()).csrf as string };
}
const origin = (p: Page) => new URL(p.url() === "about:blank" ? test.info().project.use.baseURL! : p.url()).origin;
// Seed a public share and FAIL HERE when creation is rejected (e.g. 429 RATE_LIMITED): reading .slug off an
// error body used to surface as a 404 on the media PUT / a missing prompt_shared downstream (#128).
async function createShare(req: APIRequestContext, headers: Record<string, string>, data: Record<string, unknown>) {
  const r = await req.post("/api/shares", { headers, data });
  expect(r.ok(), `POST /api/shares -> ${r.status()}: ${await r.text()}`).toBeTruthy();
  return (await r.json()) as { slug: string };
}

test("social feed: rate, comment, tag filter, report, profile (mobile + desktop)", async ({ page, browser, baseURL }) => {
  const base = new URL(baseURL!).origin; void origin;
  const owner = await browser.newContext({ baseURL }); const oh = await apiLogin(owner.request, base, "e2e-code");
  const title = `Social E2E ${test.info().project.name} ${Date.now() % 100000}`;
  const sh = await createShare(owner.request, oh, { title, project, public: true });
  const tag = `e2e-${test.info().project.name.replace(/[^a-z0-9]/g, "").slice(0, 10)}`;
  expect((await owner.request.patch(`/api/songs/${sh.slug}/meta`, { headers: oh, data: { labels: ["classical"], tags: [tag] } })).ok()).toBeTruthy();
  try {
    await apiLogin(page.request, base, "e2e-code-2");
    await page.goto("/feed?sort=new");
    const card = page.getByTestId("feed-card").filter({ hasText: title }).first();
    await expect(card).toBeVisible();
    await dismissLandingPaywall(page);
    await expect(card.getByTestId("card-pianoroll")).toBeVisible();
    // rating
    await card.getByTestId("star-4").click();
    await expect(card.getByTestId("rating-summary")).toHaveText("4.0 (1)");
    // comments: plain text, never HTML
    await card.getByTestId("card-comments").click();
    await expect(page.getByTestId("comments-sheet")).toBeVisible();
    const input = page.getByTestId("comment-input");
    expect(await input.evaluate((e) => getComputedStyle(e).fontSize)).toBe("16px");
    await input.fill("<img src=x onerror=alert(1)> lovely");
    await page.getByTestId("comment-send").click();
    await expect(page.getByTestId("comment-body").first()).toHaveText("<img src=x onerror=alert(1)> lovely");
    expect(await page.getByTestId("comments-sheet").locator("img").count()).toBe(0);
    await page.getByTestId("sheet-close").click();
    // report the song
    await card.getByTestId("card-report").click();
    await page.getByTestId("report-reason").fill("e2e test report");
    await page.getByTestId("report-send").click();
    await expect(page.getByTestId("toast")).toContainText("review");
    // tag filter + browse sheet
    await card.getByRole("button", { name: `#${tag}` }).click();
    await expect(page).toHaveURL(new RegExp(`/t/${tag}$`));
    await expect(page.getByTestId("feed-card")).toHaveCount(1);
    await page.getByTestId("browse").click(); await expect(page.getByTestId("browse-sheet")).toBeVisible(); await page.getByTestId("sheet-close").click();
    // layout: no horizontal overflow
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/social-feed-${test.info().project.name}.png` });
    // profile
    await page.getByTestId("feed-card").first().getByTestId("card-author").click();
    await expect(page.getByTestId("profile-view")).toBeVisible();
    await expect(page.getByTestId("profile-song").filter({ hasText: title })).toBeVisible();
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth)).toBe(true);
    await (await studioReveal(page, "tab-profile")).click(); await expect(page.getByTestId("profile-settings")).toBeVisible();
    expect(await page.getByTestId("settings-name").evaluate((e) => getComputedStyle(e).fontSize)).toBe("16px");
  } finally {
    await owner.request.delete(`/api/shares/${sh.slug}`, { headers: oh }); await owner.close();
  }
});

function silentWav(sec = 2, rate = 8000) {
  const n = sec * rate, b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40); return b;
}
test("social feed autoplay: tap unlocks audio, active card plays, snapping to the next card switches playback", async ({ page, browser, baseURL }) => {
  const base = new URL(baseURL!).origin;
  const owner = await browser.newContext({ baseURL }); const oh = await apiLogin(owner.request, base, "e2e-code");
  const slugs: string[] = [];
  for (const t of ["Autoplay Two", "Autoplay One"]) {
    const sh = await createShare(owner.request, oh, { title: `${t} ${test.info().project.name} ${Date.now() % 100000}`, project, public: true });
    expect((await owner.request.put(`/api/shares/${sh.slug}/media/wav`, { headers: { ...oh, "content-type": "audio/wav" }, data: silentWav() })).ok()).toBeTruthy();
    slugs.push(sh.slug);
  }
  try {
    await page.goto("/feed?sort=new");
    const cards = page.getByTestId("feed-card");
    await expect(cards.first()).toHaveAttribute("data-slug", slugs[1]);
    await expect(page.getByTestId("tap-to-play")).toBeVisible();
    await page.getByTestId("tap-to-play").click();
    await expect(cards.first()).toHaveAttribute("data-playing", "1");
    await expect(page.getByTestId("feed")).toHaveAttribute("data-unlocked", "1");
    // snap to the next card: it becomes active and plays; the first stops
    await page.getByTestId("feed").evaluate((f) => f.scrollBy({ top: f.clientHeight }));
    await expect(page.getByTestId("feed")).toHaveAttribute("data-active", "1");
    await expect(cards.nth(1)).toHaveAttribute("data-playing", "1");
    await expect(cards.first()).toHaveAttribute("data-playing", "0");
    const snap = await page.getByTestId("feed").evaluate((f) => [getComputedStyle(f).scrollSnapType, Math.round(f.scrollTop / f.clientHeight * 100)]);
    expect(String(snap[0])).toContain("mandatory"); expect(snap[1]).toBe(100);
  } finally {
    for (const s of slugs) await owner.request.delete(`/api/shares/${s}`, { headers: oh }); await owner.close();
  }
});

test("social prompt sharing: off by default, owner opts in, feed shows prompt, Remix prefills the Composer (not run)", async ({ page, browser, baseURL }) => {
  const base = new URL(baseURL!).origin;
  const owner = await browser.newContext({ baseURL }); const oh = await apiLogin(owner.request, base, "e2e-code");
  const title = `Prompt Share ${test.info().project.name} ${Date.now() % 100000}`;
  const sh = await createShare(owner.request, oh, { title, project, public: true });
  try {
    const before = await (await owner.request.get(`/api/songs/${sh.slug}`)).json(); expect(before.prompt_shared).toBe(false); expect(before.prompt_text).toBeNull();
    await owner.request.patch(`/api/songs/${sh.slug}/meta`, { headers: oh, data: { prompt_shared: true, prompt_text: "a stormy sea shanty in A minor" } });
    await apiLogin(page.request, base, "e2e-code-2");
    await page.goto("/feed?sort=new");
    const card = page.getByTestId("feed-card").filter({ hasText: title }).first();
    await expect(card.getByTestId("card-prompt")).toContainText("a stormy sea shanty in A minor");
    await dismissLandingPaywall(page);
    await card.getByTestId("card-remix").click();
    await expect(page).toHaveURL(/\/studio$/);
    const tab = page.getByTestId("tab-composer"); if (await tab.isVisible() && (await tab.getAttribute("aria-selected")) !== "true") await tab.click();
    await expect(page.getByTestId("composer-input")).toHaveValue("a stormy sea shanty in A minor");
  } finally { await owner.request.delete(`/api/shares/${sh.slug}`, { headers: oh }); await owner.close(); }
});

test("social feed switch: next starts at once, old fades out 58ms on settle, one fading voice max, preload neighbours, pause when hidden", async ({ page, browser, baseURL }) => {
  const base = new URL(baseURL!).origin;
  const owner = await browser.newContext({ baseURL }); const oh = await apiLogin(owner.request, base, "e2e-code");
  const slugs: string[] = [];
  for (const t of ["XF Four", "XF Three", "XF Two", "XF One"]) {
    const sh = await createShare(owner.request, oh, { title: `${t} ${test.info().project.name} ${Date.now() % 100000}`, project, public: true });
    expect((await owner.request.put(`/api/shares/${sh.slug}/media/wav`, { headers: { ...oh, "content-type": "audio/wav" }, data: silentWav() })).ok()).toBeTruthy();
    slugs.unshift(sh.slug);
  }
  const feed = page.getByTestId("feed"); const cards = page.getByTestId("feed-card");
  type FA = { __gbkFeedAudio: { playing: () => number; live: () => boolean; prepared: () => number } };
  const playing = () => page.evaluate(() => (window as unknown as FA).__gbkFeedAudio.playing());
  try {
    await page.goto("/feed?sort=new");
    await expect(cards.first()).toHaveAttribute("data-slug", slugs[0]);
    await page.getByTestId("tap-to-play").click();
    await expect(cards.first()).toHaveAttribute("data-playing", "1");
    // real-time SF2 engine, not a prerendered file; neighbours' render plans warmed (current + next)
    expect(await page.evaluate(() => (window as unknown as FA).__gbkFeedAudio.live())).toBe(true);
    expect(await page.getByTestId("feed-audio").evaluate((h) => [...h.querySelectorAll("audio")].filter((a) => !a.paused).length)).toBe(0);
    await expect.poll(() => page.evaluate(() => (window as unknown as FA).__gbkFeedAudio.prepared())).toBeGreaterThanOrEqual(2);
    // settle on card 2: card 1 fades out while card 2 fades in, then only one voice plays
    const sawFade = page.evaluate(() => new Promise<string>((res) => { const f = document.querySelector("[data-testid=feed]")!; const o = new MutationObserver(() => { if (f.getAttribute("data-fading")) { o.disconnect(); res(f.getAttribute("data-fading")!); } }); o.observe(f, { attributes: true }); setTimeout(() => res(""), 3000); }));
    await feed.evaluate((f) => f.scrollBy({ top: f.clientHeight }));
    expect(await sawFade).toBe(slugs[0]);
    await expect(cards.nth(1)).toHaveAttribute("data-playing", "1");
    await expect(feed).toHaveAttribute("data-fading", "", { timeout: 2000 });
    expect(await playing()).toBe(1);
    // fast scrolls: never more than 2 voices, the stale fade is cancelled
    const samples = page.evaluate(() => new Promise<number>((res) => { let max = 0; const h = document.querySelector("[data-testid=feed-audio]")!; const t0 = performance.now();
      const tick = () => { void h; max = Math.max(max, (window as unknown as { __gbkFeedAudio: { playing: () => number } }).__gbkFeedAudio.playing()); if (performance.now() - t0 < 1500) requestAnimationFrame(tick); else res(max); }; tick(); }));
    for (let i = 0; i < 2; i++) { await feed.evaluate((f) => f.scrollBy({ top: f.clientHeight })); await expect(feed).toHaveAttribute("data-active", String(2 + i)); }
    expect(await samples).toBeLessThanOrEqual(2);
    await expect(cards.nth(3)).toHaveAttribute("data-playing", "1");
    await expect.poll(playing).toBe(1);
    // tab hidden pauses everything
    await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
    await expect.poll(playing).toBe(0);
    await expect(cards.nth(3)).toHaveAttribute("data-playing", "0");
  } finally {
    for (const s of slugs) await owner.request.delete(`/api/shares/${s}`, { headers: oh }); await owner.close();
  }
});

test("first paint on / is the Feed shell, never the studio; /studio still loads directly", async ({ page }) => {
  // Hold /api/config so the "is the Composer server here" probe is still pending at first paint.
  let release!: () => void; const held = new Promise<void>((r) => { release = r; });
  await page.route("**/api/config", async (route) => { await held; await route.continue(); });
  await page.addInitScript(() => { (window as unknown as { __studioSeen: boolean }).__studioSeen = false;
    new MutationObserver(() => { const ws = document.querySelector("[data-testid=workstation], .ws-root, [data-testid=composer-input]"); if (ws && (ws as HTMLElement).offsetParent !== null) (window as unknown as { __studioSeen: boolean }).__studioSeen = true; }).observe(document, { subtree: true, childList: true, attributes: true }); });
  await page.goto("/");
  await expect(page.getByTestId("social-app")).toBeVisible();
  release();
  await expect(page.getByTestId("feed")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __studioSeen: boolean }).__studioSeen)).toBe(false);
  await page.unroute("**/api/config");
  await page.goto("/studio");
  await expect(page.getByTestId("social-app")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeVisible();
});

test("social studio: composer input always visible + in viewport on every tab, keyboard open/close, during playback (mobile + desktop)", async ({ page, baseURL }, info) => {
  test.setTimeout(150_000);
  const input = page.getByTestId("composer-input");
  // signed out: the input renders (send is gated behind sign-in) on the default tab
  await page.goto("/studio"); await expect(input).toBeVisible(); await input.fill("draft before sign-in");
  await apiLogin(page.request, new URL(baseURL!).origin, "e2e-code");
  await page.goto("/studio");
  await dismissLandingPaywall(page);
  const check = async (label: string) => {
    await expect(input, label).toBeVisible();
    const r = await input.evaluate((e) => { const b = e.getBoundingClientRect(); const vv = window.visualViewport; return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, h: vv ? vv.height + vv.offsetTop : innerHeight, w: innerWidth, fs: getComputedStyle(e).fontSize, ox: document.documentElement.scrollWidth - innerWidth }; });
    if (r.bottom > r.h + 1) { await expect.poll(() => input.evaluate((e) => { const vv = window.visualViewport; return e.getBoundingClientRect().bottom - (vv ? vv.height + vv.offsetTop : innerHeight); }), { message: label, timeout: 3000 }).toBeLessThanOrEqual(1); return; }
    expect(r.top, label).toBeGreaterThanOrEqual(0); expect(r.bottom, label).toBeLessThanOrEqual(r.h + 1);
    expect(r.left, label).toBeGreaterThanOrEqual(0); expect(r.right, label).toBeLessThanOrEqual(r.w + 1); expect(r.ox, label).toBeLessThanOrEqual(0);
    if (info.project.name.startsWith("mobile")) expect(r.fs, label).toBe("16px");
  };
  const tabs = ["tracks", "composer", "agent", "sound", "files"];
  for (const t of tabs) {
    const tab = await studioReveal(page, `tab-${t}`); if (!(await tab.count())) continue;
    await tab.click(); await check(`tab ${t}`);
    await input.focus(); await check(`tab ${t} focused`);
    const vp = page.viewportSize()!; await page.setViewportSize({ width: vp.width, height: Math.round(vp.height * 0.55) }); await check(`tab ${t} keyboard open (short viewport)`);
    await page.setViewportSize(vp); await input.blur(); await check(`tab ${t} keyboard closed`);
    if (t === "tracks") await page.screenshot({ path: info.outputPath("studio-tracks.png") });
  }
  if (!info.project.name.startsWith("mobile")) expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(0);
  for (const id of ["tab-tracks", "tab-agent"]) { const x = await studioReveal(page, id); if (await x.count() && await x.isVisible()) { await x.click(); break; } } // phone studio (no song yet): no editor tabs
  const play = page.getByTestId("ws-play");
  if (await play.isVisible()) { await play.click(); await page.waitForTimeout(800); await check("during playback"); await play.click().catch(() => undefined); }
});

test("feed impressions: settling on cards logs dwell/skip events with model_version via beacon", async ({ page, browser, baseURL }) => {
  const base = new URL(baseURL!).origin;
  const owner = await browser.newContext({ baseURL }); const oh = await apiLogin(owner.request, base, "e2e-code");
  const slugs: string[] = [];
  for (const t of ["Imp Two", "Imp One"]) { const sh = await createShare(owner.request, oh, { title: `${t} ${test.info().project.name} ${Date.now() % 100000}`, project, public: true }); slugs.unshift(sh.slug); }
  try {
    await page.goto("/feed?sort=new");
    await expect(page.getByTestId("feed-card").first()).toHaveAttribute("data-slug", slugs[0]);
    const req = page.waitForRequest((r) => r.url().endsWith("/api/events") && r.method() === "POST");
    await page.getByTestId("feed").evaluate((f) => f.scrollBy({ top: f.clientHeight }));
    await expect(page.getByTestId("feed")).toHaveAttribute("data-active", "1");
    await page.evaluate(() => { const g = (window as unknown as { __gbkImpressions: { end: () => void; flush: () => void } }).__gbkImpressions; g.end(); g.flush(); });
    await req; // the beacon reached POST /api/events (beacon bodies are not exposed to Playwright, so read the sent log)
    const body = { events: await page.evaluate(() => (window as unknown as { __gbkImpressions: { sentLog: { song: string; position: number; feed: string; model_version: string; fast_skip: boolean }[] } }).__gbkImpressions.sentLog) };
    const first = body.events.find((e: { song: string }) => e.song === slugs[0]);
    expect(first).toMatchObject({ position: 0, feed: "new", model_version: "new-1", fast_skip: true });
    expect(body.events.some((e: { song: string; position: number }) => e.song === slugs[1] && e.position === 1)).toBeTruthy();
  } finally { for (const s of slugs) await owner.request.delete(`/api/shares/${s}`, { headers: oh }); await owner.close(); }
});

test("sign-in only on demand: no Sign in button signed out; gated actions open the sheet and resume after sign-in", async ({ page, browser, baseURL }) => {
  const base = new URL(baseURL!).origin; const P = test.info().project.name;
  const owner = await browser.newContext({ baseURL }); const oh = await apiLogin(owner.request, base, "e2e-code");
  const title = `Gate E2E ${P} ${Date.now() % 100000}`;
  const sh = await createShare(owner.request, oh, { title, project, public: true });
  const noSignInButton = async () => { await expect(page.getByRole("button", { name: /sign in/i })).toHaveCount(0); await expect(page.getByRole("link", { name: /sign in/i })).toHaveCount(0); };
  const signInViaSheet = async () => { const s = page.getByTestId("signin-sheet"); await expect(s).toBeVisible(); await s.getByTestId("signin-code").fill("e2e-code-2"); await s.getByTestId("signin-code-submit").click(); await expect(page.getByTestId("signin-sheet")).toBeHidden({ timeout: 15_000 }); await page.waitForLoadState("load"); await expect(page.getByTestId("me-handle").or(page.getByTestId("composer-input")).first()).toBeVisible({ timeout: 15_000 }); await dismissLandingPaywall(page); };
  const shots = process.env.GBK_SHOTS ?? "/workspace/shots";
  try {
    // guests browse + play; no standalone Sign in anywhere (feed, profile tab, studio)
    await page.goto("/feed?sort=new");
    const card = page.getByTestId("feed-card").filter({ hasText: title }).first(); await expect(card).toBeVisible();
    await noSignInButton();
    // gated: rate -> sheet -> sign in -> rating applied
    await card.getByTestId("star-4").click();
    await expect(page.getByTestId("signin-sheet")).toBeVisible(); await expect(page.getByTestId("signin-why")).toContainText("rate");
    await page.screenshot({ path: `${shots}/signin-sheet-${P}.png` });
    await page.emulateMedia({ colorScheme: "dark" }); await page.screenshot({ path: `${shots}/signin-sheet-${P}-dark.png` }); await page.emulateMedia({ colorScheme: "light" });
    await page.getByTestId("signin-close").click(); await expect(page.getByTestId("signin-sheet")).toBeHidden();
    // gated: comment text survives sign-in and is posted
    await card.getByTestId("card-comments").click();
    const body = `resume ${P} ${Date.now() % 1000}`; await page.getByTestId("comment-input").fill(body); await page.getByTestId("comment-send").click();
    await signInViaSheet();
    await expect(page.getByTestId("comment-body").filter({ hasText: body })).toBeVisible();
    await page.getByTestId("sheet-close").click();
    // signed in: rating resumes too (new context-less check through API state)
    const r = await page.request.get(`/api/songs/${sh.slug}`); expect((await r.json()).comment_count).toBeGreaterThanOrEqual(1);
    // Sign out lives in Profile
    await (await studioReveal(page, "tab-profile")).click(); await page.getByTestId("signout").click();
    await expect(page.getByTestId("social-app")).toBeVisible(); await expect(page.getByTestId("me-handle")).toHaveCount(0);
    // profile tab signed out -> sheet; rating resumes after sign-in
    await (await studioReveal(page, "tab-profile")).click(); await expect(page.getByTestId("profile-guest")).toBeVisible(); await expect(page.getByTestId("signin-sheet")).toBeHidden();
    await page.getByTestId("profile-signin").click(); await expect(page.getByTestId("signin-sheet")).toBeVisible(); await page.getByTestId("signin-close").click();
    await (await studioReveal(page, "tab-inbox")).click(); await expect(page.getByTestId("signin-sheet")).toBeVisible(); await page.getByTestId("signin-close").click();
    await page.goto("/feed?sort=new"); const c2 = page.getByTestId("feed-card").filter({ hasText: title }).first(); await expect(c2).toBeVisible();
    await c2.getByTestId("star-5").click(); await signInViaSheet();
    await expect(page.getByTestId("feed-card").filter({ hasText: title }).first().getByTestId("star-5")).toHaveClass(/on/);
    // studio: composer text survives sign-in and is sent
    await page.request.post("/api/logout", { headers: { origin: base, "x-gbk-csrf": (await (await page.request.get("/api/session")).json()).csrf }, data: {} });
    await page.goto("/studio"); await (await studioReveal(page, "tab-composer")).click();
    await noSignInButton();
    await page.getByTestId("composer-input").fill("Gate resume prompt"); await page.getByTestId("composer-send").click();
    await signInViaSheet();
    await expect(composerConn(page)).toHaveAttribute("data-state", "connected", { timeout: 30_000 });
    await expect(page.getByText("Gate resume prompt").first()).toBeVisible({ timeout: 15_000 });
    // The replayed prompt is a real compose request: let its run finish (it must not outlive this test and be
    // adopted by the next tab of the same account). On desktop a finished run on a private song offers Publish by
    // design (same as the fugue flow); the user dismisses it and the composer is usable again.
    await expect(page.getByTestId("composer-stop")).toHaveCount(0, { timeout: 300_000 });
    if (P === "chrome-no-webmcp") { const dlg = page.getByTestId("publish-dialog"); await expect(dlg).toBeVisible({ timeout: 30_000 }); await page.getByTestId("publish-cancel").click(); await expect(dlg).toHaveCount(0); }
    await (await studioReveal(page, "tab-composer")).click();
    await expect(page.getByTestId("composer-input")).toHaveValue("");
    await expect(page.getByTestId("composer-input")).toBeInViewport();
    await page.getByTestId("composer-input").fill("still usable"); await expect(page.getByTestId("composer-input")).toHaveValue("still usable");
  } finally { await owner.request.delete(`/api/shares/${sh.slug}`, { headers: oh }); await owner.close(); }
});

test("dark mode: palette follows prefers-color-scheme, --viz-* derive from it, no overflow; light stays bright", async ({ page }) => {
  const P = test.info().project.name; const shots = process.env.GBK_SHOTS ?? "/workspace/shots";
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme }); await page.goto("/feed?sort=new"); await expect(page.getByTestId("social-app")).toBeVisible();
    const v = await page.evaluate(() => { const app = document.querySelector(".so-app")!; const cs = getComputedStyle(app); const lum = (c: string) => { const m = c.match(/\d+/g)!.map(Number); return (m[0] * 299 + m[1] * 587 + m[2] * 114) / 1000; };
      return { bg: lum(cs.backgroundColor), fg: lum(cs.color), vizBg: cs.getPropertyValue("--viz-bg").trim(), vizHead: cs.getPropertyValue("--viz-head").trim(), overflow: document.documentElement.scrollWidth > innerWidth }; });
    if (scheme === "dark") { expect(v.bg).toBeLessThan(80); expect(v.fg).toBeGreaterThan(180); expect(v.vizBg).toBe("#0f1d2a"); expect(v.vizHead).toBe("#ff5c93"); }
    else { expect(v.bg).toBeGreaterThan(200); expect(v.fg).toBeLessThan(90); expect(v.vizBg).toBe("#f8fcff"); }
    expect(v.overflow).toBeFalsy();
    await page.screenshot({ path: `${shots}/feed-${scheme}-${P}.png` });
  }
});

test("MIDI upload: Settings import accepts .mid, choose new project or add to current; bad file shows an error; composer input stays visible", async ({ page, baseURL }) => {
  const base = new URL(baseURL!).origin; await apiLogin(page.request, base, "e2e-code-2");
  await page.goto("/studio"); await (await studioReveal(page, "tab-composer")).click();
  await expect(composerConn(page)).toHaveAttribute("data-state", "connected", { timeout: 30_000 });
  await dismissLandingPaywall(page);
  const input = await studioReveal(page, "import-input");
  expect(await input.getAttribute("accept")).toContain(".mid");
  const fixture = new URL("../fixtures/import-test.mid", import.meta.url).pathname;
  await input.setInputFiles(fixture);
  await expect(page.getByTestId("midi-import")).toBeVisible();
  await page.getByTestId("midi-import-new").click();
  await expect(page.getByTestId("midi-import-msg")).toHaveText("Imported 2 tracks, 3 notes.");
  const ws = () => page.evaluate(() => { const p = (globalThis as any).__gbkWorkstation.project; return { name: p.name, tracks: p.tracks.map((t: any) => t.name), notes: p.notes.length }; });
  expect(await ws()).toEqual({ name: "import-test", tracks: ["Piano", "Violin"], notes: 3 });
  await input.setInputFiles(fixture); await page.getByTestId("midi-import-merge").click();
  await expect(page.getByTestId("midi-import-msg")).toHaveText("Imported 2 tracks, 3 notes.");
  expect((await ws()).tracks).toHaveLength(4);
  await input.setInputFiles({ name: "broken.mid", mimeType: "audio/midi", buffer: Buffer.from("not midi at all") });
  await page.getByTestId("midi-import-new").click();
  await expect(page.getByTestId("midi-import-msg")).toContainText("Not a readable MIDI file");
  await expect(page.getByTestId("composer-input")).toBeInViewport();
});

test("hardware MIDI keyboard: button next to Keys/Hum, mocked Web MIDI plays + records into the selected track, hot-plug; unsupported -> disabled with message", async ({ page }) => {
  const P = test.info().project.name;
  if (P === "mobile-webkit") {
    await page.goto("/studio");
    const b = await studioReveal(page, "midi-toggle");
    if (await page.getByTestId("plus-btn").count()) await expect(b).toHaveText("MIDI keyboards need Chrome/Edge or the iOS app."); // phone studio: + -> MIDI keyboard
    else { await expect(b).toBeDisabled(); await expect(b).toHaveAttribute("title", "MIDI keyboards need Chrome/Edge or the iOS app"); }
    await expect(page.getByTestId("composer-input")).toBeInViewport();
    return;
  }
  await page.addInitScript(() => {
    type L = (e: { data: Uint8Array }) => void;
    const mk = (id: string, name: string) => { const ls = new Set<L>(); return { id, name, manufacturer: "Test", state: "connected", addEventListener: (_t: string, f: L) => ls.add(f), removeEventListener: (_t: string, f: L) => ls.delete(f), send: (...b: number[]) => ls.forEach((f) => f({ data: new Uint8Array(b) })) }; };
    const map = new Map<string, ReturnType<typeof mk>>(); const k1 = mk("k1", "Mock Keys 49"); map.set("k1", k1);
    const access = { inputs: map, onstatechange: null as null | ((e: unknown) => void) };
    (window as any).__midiMock = { k1, plug: (id: string, n: string) => { map.set(id, mk(id, n)); access.onstatechange?.({}); } };
    Object.defineProperty(navigator, "requestMIDIAccess", { value: async () => access, configurable: true });
  });
  await page.goto("/studio");
  await page.evaluate(() => { const c = (globalThis as any).__gbkWorkstation; c.edit([{ op: "addTrack", name: "Keys In", channel: 0 }], { label: "t" }); c.setSelection({ trackIds: [c.project.tracks[c.project.tracks.length - 1].id] }); });
  await (await studioReveal(page, "midi-toggle")).click();
  await expect(page.getByTestId("midi-status")).toHaveAttribute("data-kind", "ready");
  await expect(page.getByTestId("midi-device")).toContainText("Mock Keys 49");
  await page.evaluate(() => (window as any).__midiMock.plug("k2", "Mock Pad"));
  await expect(page.getByTestId("midi-device")).toContainText("Mock Pad");
  const n = await page.evaluate(async () => {
    const c = (globalThis as any).__gbkWorkstation; const live = (window as any).__gbkLive; const k1 = (window as any).__midiMock.k1;
    live.session.setArmed(true); c.updateTransport({ playing: true });
    k1.send(0x90, 60, 100); k1.send(0xb0, 64, 127); k1.send(0x80, 60, 0); k1.send(0xb0, 1, 64); k1.send(0xe0, 0, 0x50);
    await new Promise((r) => setTimeout(r, 60)); k1.send(0xb0, 64, 0);
    c.updateTransport({ playing: false }); await new Promise((r) => setTimeout(r, 20));
    const tid = c.project.tracks[c.project.tracks.length - 1].id;
    return { notes: c.project.notes.filter((x: any) => x.trackId === tid).map((x: any) => x.pitch), cc1: c.project.ccs.filter((x: any) => x.trackId === tid && x.controller === 1).length, cc64: c.project.ccs.filter((x: any) => x.controller === 64).length, bends: c.project.pitchBends.filter((x: any) => x.trackId === tid).length };
  });
  expect(n).toEqual({ notes: [60], cc1: 1, cc64: 0, bends: 1 });
  await expect(page.getByTestId("composer-input")).toBeInViewport();
});

test("social studio iOS hum bridge: gbkNative hum shows the prompt-bar button, gbkHum.apply adds a 'Hummed melody' track, composer input stays visible", async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as { gbkNative: unknown }).gbkNative = { platform: "ios", version: 1, capabilities: ["hum"] }; (window as unknown as { __humMsgs: unknown[] }).__humMsgs = [];
    (window as unknown as { webkit: unknown }).webkit = { messageHandlers: { hum: { postMessage: (m: unknown) => (window as unknown as { __humMsgs: unknown[] }).__humMsgs.push(m) } } }; });
  await page.goto("/studio");
  // gbkNative => the phone studio: the mic in the input bar drives the native recorder.
  const btn = page.getByTestId("composer-bar").getByTestId("hum-btn"); await expect(btn).toBeVisible({ timeout: 30_000 }); await expect(page.getByTestId("hum-btn")).toHaveCount(1);
  await btn.click(); expect(await page.evaluate(() => (window as unknown as { __humMsgs: unknown[] }).__humMsgs)).toEqual([{ type: "toggle" }]);
  await page.evaluate(() => (window as unknown as { gbkHum: { onState: (s: object) => void } }).gbkHum.onState({ phase: "recording", elapsed: 12, progress: 0 })); await expect(page.getByTestId("hum-strip")).toContainText("0:12"); await expect(btn).toHaveAttribute("aria-label", "Done humming");
  const ctx = await page.evaluate(() => (window as unknown as { gbkHum: { context: () => { ppq: number; tracks: { channel: number }[] } } }).gbkHum.context());
  const ch = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10].find((c) => !ctx.tracks.some((t) => t.channel === c))!;
  const ops = [{ op: "addTrack", id: "hume2e", name: "Hummed melody", channel: ch, program: 0, bankMsb: 0, bankLsb: 0, role: "melody" },
    { op: "addNotes", notes: [60, 62, 64].map((p, i) => ({ trackId: "hume2e", channel: ch, tick: i * ctx.ppq, duration: ctx.ppq, pitch: p, velocity: 100 })) }];
  const r = await page.evaluate((o) => (window as unknown as { gbkHum: { apply: (o: unknown, x: object) => unknown } }).gbkHum.apply(o, { label: "hum a melody", selectTrackId: "hume2e" }), ops);
  expect(r).toMatchObject({ ok: true, trackId: "hume2e", notes: 3 });
  expect(await page.evaluate((o) => (window as unknown as { gbkHum: { apply: (o: unknown) => { ok: boolean } } }).gbkHum.apply(o).ok, ops)).toBe(false);
  await page.evaluate(() => (window as unknown as { gbkHum: { onState: (s: object) => void } }).gbkHum.onState({ phase: "idle" }));
  await expect(page.getByText("Hummed melody").first()).toBeVisible();
  const input = page.getByTestId("composer-input"); await expect(input).toBeVisible(); await expect(input).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("hum-bridge.png") });
});

test("social feed play button is accessible: aria-label Play/Pause + aria-pressed", async ({ page, browser, baseURL }) => {
  const base = new URL(baseURL!).origin; const owner = await browser.newContext({ baseURL }); const oh = await apiLogin(owner.request, base, "e2e-code");
  const title = `A11y ${test.info().project.name} ${Date.now() % 100000}`; const sh = await createShare(owner.request, oh, { title, project, public: true });
  expect((await owner.request.put(`/api/shares/${sh.slug}/media/wav`, { headers: { ...oh, "content-type": "audio/wav" }, data: silentWav() })).ok()).toBeTruthy();
  try {
  await page.goto("/feed?sort=new");
  const b = page.getByTestId("feed-card").filter({ hasText: title }).getByTestId("card-play"); await expect(b).toBeVisible();
  await expect(b).toHaveAttribute("aria-label", /^(Play|Pause)$/); await expect(b).toHaveAttribute("aria-pressed", /^(true|false)$/);
  expect(await b.evaluate((e) => e.tagName)).toBe("BUTTON");
  // badge sits inside the roll (bottom-left) and the roll never scrolls, paused or playing
  const inRoll = () => b.evaluate((e) => { const w = e.parentElement!, r = e.getBoundingClientRect(), q = w.getBoundingClientRect(); return getComputedStyle(e).position === "absolute" && w.scrollTop === 0 && r.bottom <= q.bottom && r.left >= q.left && r.right <= q.right; });
  expect(await inRoll()).toBe(true);
  const was = await b.getAttribute("aria-pressed"); await b.click();
  await expect(b).toHaveAttribute("aria-pressed", was === "true" ? "false" : "true");
  await expect(b).toHaveAttribute("aria-label", was === "true" ? "Play" : "Pause");
  expect(await inRoll()).toBe(true);
  } finally { await owner.request.delete(`/api/shares/${sh.slug}`, { headers: oh }); await owner.close(); }
});

test("social remix: the prompt carries the song - fork loads, A major remaps the fork, Original stays for A/B (#162)", async ({ page, browser, baseURL }) => {
  const base = new URL(baseURL!).origin;
  const owner = await browser.newContext({ baseURL }); const oh = await apiLogin(owner.request, base, "e2e-code");
  const title = `Remix E2E ${test.info().project.name} ${Date.now() % 100000}`;
  const sh = await createShare(owner.request, oh, { title, project, public: true });
  const promptText = "a stormy sea shanty in C major";
  expect((await owner.request.patch(`/api/songs/${sh.slug}/meta`, { headers: oh, data: { prompt_shared: true, prompt_text: promptText } })).ok()).toBeTruthy();
  const wsState = () => page.evaluate(() => { const c = (globalThis as any).__gbkWorkstation; const p = c.project; return { name: p.name, key: p.meta?.key ?? null, forkOf: p.meta?.forkOf ?? null, owner: p.meta?.owner ?? null, pitches: p.notes.map((n: any) => n.pitch).sort((a: number, b: number) => a - b) }; });
  try {
    await apiLogin(page.request, base, "e2e-code-2");
    await page.goto("/feed?sort=new");
    const card = page.getByTestId("feed-card").filter({ hasText: title }).first();
    await expect(card).toBeVisible();
    await dismissLandingPaywall(page);
    await card.getByTestId("card-remix").click();
    // The fork - not an empty project - is what the fresh session opens, and the prompt rides along prefilled.
    await expect(page.getByTestId("studio-title")).toHaveText(`${title} (fork)`, { timeout: 30_000 });
    const loaded = await wsState();
    expect(loaded.forkOf).toBe(sh.slug); expect(loaded.owner).toBe("user");
    expect(loaded.pitches).toEqual((project as any).notes.map((n: any) => n.pitch).sort((a: number, b: number) => a - b));
    await expect(page.getByTestId("composer-input")).toHaveValue(promptText);
    await expect(page.getByTestId("version-card").filter({ hasText: "Original" })).toBeVisible();
    // Ask for the key change: the agent must READ the fork and TRANSFORM it (never create a new project).
    await page.getByTestId("composer-input").fill("rewrite this in A major");
    await page.getByTestId("composer-send").click();
    // The fork is user-owned, so the remap arrives as a proposal: Accept it in the agent panel.
    const accept = page.locator(".ws-accept").first();
    await expect(accept).toBeVisible({ timeout: 120_000 });
    await accept.click();
    await expect(page.getByTestId("assistant-text").last()).toContainText("Rewrote it in A major", { timeout: 120_000 });
    const after = await wsState();
    expect(after.name).toBe(`${title} (fork)`); expect(after.forkOf).toBe(sh.slug);
    expect(after.key).toBe("A major");
    // C major -> A major is a pure -3 shift (degree map is identity major->major): every pitch moved, none created.
    expect(after.pitches).toEqual((project as any).notes.map((n: any) => n.pitch - 3).sort((a: number, b: number) => a - b));
    // A/B: the Original card is still there next to the new version.
    await expect(page.getByTestId("version-card").filter({ hasText: "Original" })).toBeVisible();
    expect(await page.getByTestId("version-card").count()).toBeGreaterThanOrEqual(2);
  } finally { await owner.request.delete(`/api/shares/${sh.slug}`, { headers: oh }); await owner.close(); }
});

test("social remix fallback: a share that fails to load still lands in a FRESH session (#164 review 2)", async ({ page, browser, baseURL }) => {
  const base = new URL(baseURL!).origin;
  const owner = await browser.newContext({ baseURL }); const oh = await apiLogin(owner.request, base, "e2e-code");
  const stamp = `${test.info().project.name} ${Date.now() % 100000}`;
  const titleA = `Remix OK ${stamp}`; const titleB = `Remix Gone ${stamp}`;
  const shA = await createShare(owner.request, oh, { title: titleA, project, public: true });
  const shB = await createShare(owner.request, oh, { title: titleB, project, public: true });
  const promptB = "a lullaby that cannot load";
  expect((await owner.request.patch(`/api/songs/${shA.slug}/meta`, { headers: oh, data: { prompt_shared: true, prompt_text: "a stormy sea shanty in C major" } })).ok()).toBeTruthy();
  expect((await owner.request.patch(`/api/songs/${shB.slug}/meta`, { headers: oh, data: { prompt_shared: true, prompt_text: promptB } })).ok()).toBeTruthy();
  const wsState = () => page.evaluate(() => { const p = (globalThis as any).__gbkWorkstation.project; return { forkOf: p.meta?.forkOf ?? null, notes: p.notes.length }; });
  try {
    await apiLogin(page.request, base, "e2e-code-2");
    await page.goto("/feed?sort=new");
    await dismissLandingPaywall(page);
    // Establish the previous session: remix A successfully, so A's fork is the live project.
    const cardA = page.getByTestId("feed-card").filter({ hasText: titleA }).first();
    await expect(cardA).toBeVisible();
    await cardA.getByTestId("card-remix").click();
    await expect(page.getByTestId("studio-title")).toHaveText(`${titleA} (fork)`, { timeout: 30_000 });
    expect((await wsState()).forkOf).toBe(shA.slug);
    // Back to the feed; B is deleted server-side while its card is still on screen.
    const back = page.getByTestId("studio-back");
    if (await back.isVisible().catch(() => false)) await back.click(); else await page.getByTestId("nav-explore").click();
    const cardB = page.getByTestId("feed-card").filter({ hasText: titleB }).first();
    await expect(cardB).toBeVisible();
    expect((await owner.request.delete(`/api/shares/${shB.slug}`, { headers: oh })).ok()).toBeTruthy();
    await cardB.getByTestId("card-remix").click();
    // The load fails (404): the landing must still be a FRESH session (#161) — a new empty project
    // with B's prompt in the composer and the failure toast, NOT A's fork with the prompt pasted on top.
    await expect(page.getByTestId("studio-toast")).toContainText("Couldn't load that song", { timeout: 30_000 });
    await expect(page.getByTestId("composer-input")).toHaveValue(promptB);
    const after = await wsState();
    expect(after.forkOf).toBeNull(); expect(after.notes).toBe(0);
  } finally { await owner.request.delete(`/api/shares/${shA.slug}`, { headers: oh }).catch(() => undefined); await owner.close(); }
});
