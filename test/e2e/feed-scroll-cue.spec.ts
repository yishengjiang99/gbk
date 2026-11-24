// The feed view's scroll cue on WebKit iPhone (real Composer server): a fresh visit shows the "Swipe up" chevron on the
// first card and bounces once 2 s after the first song plays; the first scroll to card 2 hides it for good (also
// after a reload); reduced motion shows a static chevron and never bounces. Seeds two public songs, deletes them after.
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const project = JSON.parse(readFileSync(new URL("../fixtures/social-song.json", import.meta.url), "utf8"));
const SHOTS = process.env.GBK_FEED_CUE_SHOTS ?? "/workspace";
const KEY = "gbk_feed_scroll_cue_done";
// Test-traffic marker: excluded from analytics.
test.use({ extraHTTPHeaders: { "X-GBK-Test": "1" } });
test.beforeEach(async ({ page }) => {
  test.skip(test.info().project.name !== "mobile-webkit", "WebKit iPhone only");
  // Headless Linux WebKit has no audio output (its AudioContext never runs and <audio>.play() rejects), so the feed
  // view could never report a song as playing. Stand in a silent media element; the cue only reacts to "playing".
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>; delete w.AudioContext; delete w.webkitAudioContext;
    const off = new WeakSet<HTMLMediaElement>(); const on = new WeakSet<HTMLMediaElement>();
    Object.defineProperty(HTMLMediaElement.prototype, "paused", { configurable: true, get(this: HTMLMediaElement) { return !on.has(this) || off.has(this); } });
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) { on.add(this); off.delete(this); return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) { off.add(this); };
    // never hand the (crash-prone, soundless) Linux media pipeline a source: keep src as a plain property
    const srcs = new WeakMap<HTMLMediaElement, string>();
    Object.defineProperty(HTMLMediaElement.prototype, "src", { configurable: true, get(this: HTMLMediaElement) { return srcs.get(this) ?? ""; }, set(this: HTMLMediaElement, v: string) { srcs.set(this, v); } });
    HTMLMediaElement.prototype.load = function () { /* no media pipeline */ };
  });
});

async function apiLogin(req: APIRequestContext, base: string, code: string) {
  const csrf = (await (await req.get("/api/session")).json()).csrf as string;
  const r = await req.post("/api/login", { headers: { origin: base, "x-gbk-csrf": csrf }, data: { code } }); expect(r.ok()).toBeTruthy();
  return { origin: base, "x-gbk-csrf": (await r.json()).csrf as string };
}
function silentWav(sec = 6, rate = 8000) {
  const n = sec * rate, b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40); return b;
}
/** Two public songs at the top of /feed?sort=new; returns a cleanup. */
async function seed(page: Page, baseURL: string, label: string) {
  const base = new URL(baseURL).origin;
  const owner = await page.context().browser()!.newContext({ baseURL, extraHTTPHeaders: { "X-GBK-Test": "1" } }); const oh = await apiLogin(owner.request, base, "e2e-code");
  const slugs: string[] = [];
  for (const t of ["Cue Two", "Cue One"]) {
    const r = await owner.request.post("/api/shares", { headers: oh, data: { title: `${t} ${label} ${Date.now() % 100000}`, project, public: true } });
    expect(r.ok(), `POST /api/shares -> ${r.status()}`).toBeTruthy(); const { slug } = await r.json() as { slug: string };
    expect((await owner.request.put(`/api/shares/${slug}/media/wav`, { headers: { ...oh, "content-type": "audio/wav" }, data: silentWav() })).ok()).toBeTruthy();
    slugs.push(slug);
  }
  return async () => { for (const s of slugs) await owner.request.delete(`/api/shares/${s}`, { headers: oh }); await owner.close(); };
}
/** Records the furthest the feed view's cards moved up (px, from their transform) while the page runs. */
const watchLift = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __lift: number }; w.__lift = 0;
  const tick = () => { const c = document.querySelector<HTMLElement>('[data-testid=feed] [data-idx="1"]');
    if (c) w.__lift = Math.max(w.__lift, -new DOMMatrixReadOnly(getComputedStyle(c).transform === "none" ? undefined : getComputedStyle(c).transform).m42); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
const lift = (page: Page) => page.evaluate(() => (window as unknown as { __lift: number }).__lift);
async function startFirstSong(page: Page) {
  const cards = page.getByTestId("feed-card");
  await expect(cards.nth(1)).toBeAttached({ timeout: 30_000 });
  await page.getByTestId("tap-to-play").tap();
  await expect(cards.first()).toHaveAttribute("data-playing", "1", { timeout: 30_000 });
}

test("iphone feed view scroll cue: chevron shows, one bounce after the first song starts", async ({ page, baseURL }) => {
  const cleanup = await seed(page, baseURL!, "bounce");
  try {
    await page.goto("/feed?sort=new");
    const cue = page.getByTestId("feed-card").first().getByTestId("feed-scroll-cue");
    await expect(cue).toBeVisible({ timeout: 30_000 });
    await expect(cue).toHaveText("Swipe up");
    expect(await cue.evaluate((e) => getComputedStyle(e).animationName)).toBe("so-cue-pulse");
    expect(await cue.evaluate((e) => getComputedStyle(e).pointerEvents)).toBe("none");
    await expect(page.getByTestId("feed-scroll-cue")).toHaveCount(1); // first card only
    await watchLift(page);
    await startFirstSong(page);
    const t0 = Date.now(); const feed = page.getByTestId("feed");
    await expect(feed).toHaveAttribute("data-cue-bouncing", "1", { timeout: 6_000 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_500);
    await expect(feed).toHaveAttribute("data-cue-bounced", "1", { timeout: 5_000 });
    const p = await lift(page); expect(p).toBeGreaterThan(50); expect(p).toBeLessThanOrEqual(70.5); // up 70px (rAF samples may miss the exact peak)
    // the bounce is a transform: scroll position, active card and the card heights are untouched
    expect(await feed.evaluate((f) => f.scrollTop)).toBe(0);
    await expect(feed).toHaveAttribute("data-active", "0");
    expect(await feed.evaluate((f) => Math.abs(f.querySelector<HTMLElement>('[data-idx="0"]')!.getBoundingClientRect().height - f.clientHeight) <= 1)).toBe(true);
    await expect(cue).toBeVisible(); // the bounce alone does not count as a scroll
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull();
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `${SHOTS}/feed-cue-iphone.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: `${SHOTS}/feed-cue-iphone-dark.png` });
  } finally { await cleanup(); }
});

test("iphone feed view scroll cue: first scroll to card 2 hides it for good", async ({ page, baseURL }) => {
  const cleanup = await seed(page, baseURL!, "hide");
  try {
    await page.goto("/feed?sort=new");
    const feed = page.getByTestId("feed"); const cue = page.getByTestId("feed-scroll-cue");
    await expect(cue).toBeVisible({ timeout: 30_000 });
    await feed.evaluate((f) => f.scrollTo({ top: f.clientHeight }));
    await expect(feed).toHaveAttribute("data-active", "1");
    await expect(cue).toHaveCount(0);
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe("1");
    await feed.evaluate((f) => f.scrollTo({ top: 0 }));
    await expect(feed).toHaveAttribute("data-active", "0");
    await expect(cue).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("feed-card").nth(1)).toBeAttached({ timeout: 30_000 });
    await startFirstSong(page);
    await page.waitForTimeout(3_200);
    await expect(cue).toHaveCount(0);
    expect(await feed.getAttribute("data-cue-bounced")).toBeNull();
  } finally { await cleanup(); }
});

test("iphone feed view scroll cue: reduced motion shows a static chevron and never bounces", async ({ page, baseURL }) => {
  const cleanup = await seed(page, baseURL!, "still");
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/feed?sort=new");
    const feed = page.getByTestId("feed"); const cue = page.getByTestId("feed-scroll-cue");
    await expect(cue).toBeVisible({ timeout: 30_000 }); await expect(cue).toHaveText("Swipe up");
    expect(await cue.evaluate((e) => getComputedStyle(e).animationName)).toBe("none");
    await watchLift(page);
    await startFirstSong(page);
    await page.waitForTimeout(3_500);
    expect(await feed.getAttribute("data-cue-bouncing")).toBeNull(); expect(await feed.getAttribute("data-cue-bounced")).toBeNull();
    expect(await lift(page)).toBe(0);
    await expect(cue).toBeVisible();
    await feed.evaluate((f) => f.scrollTo({ top: f.clientHeight }));
    await expect(feed).toHaveAttribute("data-active", "1");
    await expect(cue).toHaveCount(0);
  } finally { await cleanup(); }
});
