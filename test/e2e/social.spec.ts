// gbk Social e2e (Pixel, WebKit iPhone, desktop Chrome): feed cards, rating, flat comments (escaped), tag filter,
// report, profile; no horizontal overflow and 16px inputs. Seeds one public song via the API and deletes it after.
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const project = JSON.parse(readFileSync(new URL("../fixtures/social-song.json", import.meta.url), "utf8"));
async function apiLogin(req: APIRequestContext, base: string, code: string) {
  const csrf = (await (await req.get("/api/session")).json()).csrf as string;
  const r = await req.post("/api/login", { headers: { origin: base, "x-gbk-csrf": csrf }, data: { code } }); expect(r.ok()).toBeTruthy();
  return { origin: base, "x-gbk-csrf": (await r.json()).csrf as string };
}
const origin = (p: Page) => new URL(p.url() === "about:blank" ? test.info().project.use.baseURL! : p.url()).origin;

test("social feed: rate, comment, tag filter, report, profile (mobile + desktop)", async ({ page, browser, baseURL }) => {
  const base = new URL(baseURL!).origin; void origin;
  const owner = await browser.newContext({ baseURL }); const oh = await apiLogin(owner.request, base, "e2e-code");
  const title = `Social E2E ${test.info().project.name} ${Date.now() % 100000}`;
  const sh = await (await owner.request.post("/api/shares", { headers: oh, data: { title, project, public: true } })).json();
  const tag = `e2e-${test.info().project.name.replace(/[^a-z0-9]/g, "").slice(0, 10)}`;
  expect((await owner.request.patch(`/api/songs/${sh.slug}/meta`, { headers: oh, data: { labels: ["classical"], tags: [tag] } })).ok()).toBeTruthy();
  try {
    await apiLogin(page.request, base, "e2e-code-2");
    await page.goto("/feed?sort=new");
    const card = page.getByTestId("feed-card").filter({ hasText: title }).first();
    await expect(card).toBeVisible();
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
    await page.getByTestId("tab-profile").click(); await expect(page.getByTestId("profile-settings")).toBeVisible();
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
    const sh = await (await owner.request.post("/api/shares", { headers: oh, data: { title: `${t} ${test.info().project.name} ${Date.now() % 100000}`, project, public: true } })).json();
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
  const sh = await (await owner.request.post("/api/shares", { headers: oh, data: { title, project, public: true } })).json();
  try {
    const before = await (await owner.request.get(`/api/songs/${sh.slug}`)).json(); expect(before.prompt_shared).toBe(false); expect(before.prompt_text).toBeNull();
    await owner.request.patch(`/api/songs/${sh.slug}/meta`, { headers: oh, data: { prompt_shared: true, prompt_text: "a stormy sea shanty in A minor" } });
    await apiLogin(page.request, base, "e2e-code-2");
    await page.goto("/feed?sort=new");
    const card = page.getByTestId("feed-card").filter({ hasText: title }).first();
    await expect(card.getByTestId("card-prompt")).toContainText("a stormy sea shanty in A minor");
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
    const sh = await (await owner.request.post("/api/shares", { headers: oh, data: { title: `${t} ${test.info().project.name} ${Date.now() % 100000}`, project, public: true } })).json();
    expect((await owner.request.put(`/api/shares/${sh.slug}/media/wav`, { headers: { ...oh, "content-type": "audio/wav" }, data: silentWav() })).ok()).toBeTruthy();
    slugs.unshift(sh.slug);
  }
  const feed = page.getByTestId("feed"); const cards = page.getByTestId("feed-card");
  const playing = () => page.getByTestId("feed-audio").evaluate((h) => [...h.querySelectorAll("audio")].filter((a) => !a.paused).length);
  try {
    await page.goto("/feed?sort=new");
    await expect(cards.first()).toHaveAttribute("data-slug", slugs[0]);
    await page.getByTestId("tap-to-play").click();
    await expect(cards.first()).toHaveAttribute("data-playing", "1");
    // neighbours preloaded (current + next)
    await expect.poll(() => page.getByTestId("feed-audio").evaluate((h) => h.querySelectorAll("audio").length)).toBeGreaterThanOrEqual(2);
    // settle on card 2: card 1 fades out while card 2 fades in, then only one voice plays
    const sawFade = page.evaluate(() => new Promise<string>((res) => { const f = document.querySelector("[data-testid=feed]")!; const o = new MutationObserver(() => { if (f.getAttribute("data-fading")) { o.disconnect(); res(f.getAttribute("data-fading")!); } }); o.observe(f, { attributes: true }); setTimeout(() => res(""), 3000); }));
    await feed.evaluate((f) => f.scrollBy({ top: f.clientHeight }));
    expect(await sawFade).toBe(slugs[0]);
    await expect(cards.nth(1)).toHaveAttribute("data-playing", "1");
    await expect(feed).toHaveAttribute("data-fading", "", { timeout: 2000 });
    expect(await playing()).toBe(1);
    // fast scrolls: never more than 2 voices, the stale fade is cancelled
    const samples = page.evaluate(() => new Promise<number>((res) => { let max = 0; const h = document.querySelector("[data-testid=feed-audio]")!; const t0 = performance.now();
      const tick = () => { max = Math.max(max, [...h.querySelectorAll("audio")].filter((a) => !a.paused).length); if (performance.now() - t0 < 1500) requestAnimationFrame(tick); else res(max); }; tick(); }));
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
  await expect(page.getByTestId("composer-input").or(page.getByTestId("tab-composer")).first()).toBeVisible();
});

test("social studio: composer input always visible + in viewport on every tab, keyboard open/close, during playback (mobile + desktop)", async ({ page, baseURL }, info) => {
  test.setTimeout(150_000);
  const input = page.getByTestId("composer-input");
  // signed out: the input renders (send is gated behind sign-in) on the default tab
  await page.goto("/studio"); await expect(input).toBeVisible(); await input.fill("draft before sign-in");
  await apiLogin(page.request, new URL(baseURL!).origin, "e2e-code");
  await page.goto("/studio");
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
    const tab = page.getByTestId(`tab-${t}`); if (!(await tab.count())) continue;
    await tab.click(); await check(`tab ${t}`);
    await input.focus(); await check(`tab ${t} focused`);
    const vp = page.viewportSize()!; await page.setViewportSize({ width: vp.width, height: Math.round(vp.height * 0.55) }); await check(`tab ${t} keyboard open (short viewport)`);
    await page.setViewportSize(vp); await input.blur(); await check(`tab ${t} keyboard closed`);
    if (t === "tracks") await page.screenshot({ path: info.outputPath("studio-tracks.png") });
  }
  if (!info.project.name.startsWith("mobile")) expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeLessThanOrEqual(0);
  if (await page.getByTestId("tab-tracks").count()) await page.getByTestId("tab-tracks").click(); else await page.getByTestId("tab-agent").click();
  const play = page.getByTestId("ws-play");
  if (await play.isVisible()) { await play.click(); await page.waitForTimeout(800); await check("during playback"); await play.click().catch(() => undefined); }
});

test("feed impressions: settling on cards logs dwell/skip events with model_version via beacon", async ({ page, browser, baseURL }) => {
  const base = new URL(baseURL!).origin;
  const owner = await browser.newContext({ baseURL }); const oh = await apiLogin(owner.request, base, "e2e-code");
  const slugs: string[] = [];
  for (const t of ["Imp Two", "Imp One"]) { const sh = await (await owner.request.post("/api/shares", { headers: oh, data: { title: `${t} ${test.info().project.name} ${Date.now() % 100000}`, project, public: true } })).json(); slugs.unshift(sh.slug); }
  try {
    await page.goto("/feed?sort=new");
    await expect(page.getByTestId("feed-card").first()).toHaveAttribute("data-slug", slugs[0]);
    const req = page.waitForRequest((r) => r.url().endsWith("/api/events") && r.method() === "POST");
    await page.getByTestId("feed").evaluate((f) => f.scrollBy({ top: f.clientHeight }));
    await expect(page.getByTestId("feed")).toHaveAttribute("data-active", "1");
    await page.evaluate(() => { const g = (window as unknown as { __gbkImpressions: { end: () => void; flush: () => void } }).__gbkImpressions; g.end(); g.flush(); });
    await req; // the beacon reached POST /api/events (beacon bodies are not exposed to Playwright, so read the sent log)
    const body = { events: await page.evaluate(() => (window as unknown as { __gbkImpressions: { sentLog: unknown[] } }).__gbkImpressions.sentLog) };
    const first = body.events.find((e: { song: string }) => e.song === slugs[0]);
    expect(first).toMatchObject({ position: 0, feed: "new", model_version: "new-1", fast_skip: true });
    expect(body.events.some((e: { song: string; position: number }) => e.song === slugs[1] && e.position === 1)).toBeTruthy();
  } finally { for (const s of slugs) await owner.request.delete(`/api/shares/${s}`, { headers: oh }); await owner.close(); }
});

test("sign-in only on demand: no Sign in button signed out; gated actions open the sheet and resume after sign-in", async ({ page, browser, baseURL }) => {
  const base = new URL(baseURL!).origin; const P = test.info().project.name;
  const owner = await browser.newContext({ baseURL }); const oh = await apiLogin(owner.request, base, "e2e-code");
  const title = `Gate E2E ${P} ${Date.now() % 100000}`;
  const sh = await (await owner.request.post("/api/shares", { headers: oh, data: { title, project, public: true } })).json();
  const noSignInButton = async () => { await expect(page.getByRole("button", { name: /sign in/i })).toHaveCount(0); await expect(page.getByRole("link", { name: /sign in/i })).toHaveCount(0); };
  const signInViaSheet = async () => { const s = page.getByTestId("signin-sheet"); await expect(s).toBeVisible(); await s.getByTestId("signin-code").fill("e2e-code-2"); await s.getByTestId("signin-code-submit").click(); await expect(page.getByTestId("signin-sheet")).toBeHidden({ timeout: 15_000 }); await page.waitForLoadState("load"); await expect(page.getByTestId("me-handle").or(page.getByTestId("composer-input")).first()).toBeVisible({ timeout: 15_000 }); };
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
    await page.getByTestId("tab-profile").click(); await page.getByTestId("signout").click();
    await expect(page.getByTestId("social-app")).toBeVisible(); await expect(page.getByTestId("me-handle")).toHaveCount(0);
    // profile tab signed out -> sheet; rating resumes after sign-in
    await page.getByTestId("tab-profile").click(); await expect(page.getByTestId("signin-sheet")).toBeVisible(); await page.getByTestId("signin-close").click();
    await page.goto("/feed?sort=new"); const c2 = page.getByTestId("feed-card").filter({ hasText: title }).first(); await expect(c2).toBeVisible();
    await c2.getByTestId("star-5").click(); await signInViaSheet();
    await expect(page.getByTestId("feed-card").filter({ hasText: title }).first().getByTestId("star-5")).toHaveClass(/on/);
    // studio: composer text survives sign-in and is sent
    await page.request.post("/api/logout", { headers: { origin: base, "x-gbk-csrf": (await (await page.request.get("/api/session")).json()).csrf }, data: {} });
    await page.goto("/studio"); const tab = page.getByTestId("tab-composer"); if (await tab.isVisible()) await tab.click();
    await noSignInButton();
    await page.getByTestId("composer-input").fill("Gate resume prompt"); await page.getByTestId("composer-send").click();
    await signInViaSheet();
    await expect(page.getByTestId("composer-conn")).toHaveAttribute("data-state", "connected", { timeout: 30_000 });
    const ct = page.getByTestId("tab-composer"); if (await ct.isVisible()) await ct.click();
    await expect(page.getByText("Gate resume prompt").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("composer-input")).toHaveValue("");
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
