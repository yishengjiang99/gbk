// Paywall plan (approved 2026-11-16: "Approve the paywall plan, drop the landing paywall", "Export is Pro only").
// Real Composer server + real Studio: no landing paywall (signed out or in), export is a hard block for non-Pro
// users (the server answers POST /api/paywall/check with 402 and nothing downloads), the 3rd-song popup shows once,
// is dismissible and is remembered server-side, and the hard AI-budget gate still blocks. Runs on desktop Chrome,
// Pixel, and WebKit iPhone (screenshots under GBK_PAYWALL_SHOTS, default /workspace/paywall-shots).
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { composerConn, studioReveal } from "./app-menu";

const SHOTS = process.env.GBK_PAYWALL_SHOTS ?? process.env.GBK_SHOTS ?? "/workspace/paywall-shots";
mkdirSync(SHOTS, { recursive: true });
const FIXTURE_MID = new URL("../fixtures/import-test.mid", import.meta.url).pathname;
const SONG = JSON.parse(readFileSync(new URL("../fixtures/social-song.json", import.meta.url), "utf8"));

// The one-time 3rd-song popup is under test here: start from clean storage (composer.config pre-seeds it as seen).
test.use({ storageState: { cookies: [], origins: [] }, actionTimeout: 20_000, navigationTimeout: 60_000 });

async function signIn(page: Page, code: string) {
  await expect(page.getByTestId("workstation")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("gbk:need-signin", { detail: { why: "Sign in", pending: null } })));
  await expect(page.getByTestId("signin-sheet")).toBeVisible();
  await page.getByTestId("signin-code").fill(code); await page.getByTestId("signin-code-submit").click();
  await expect(page.getByTestId("signin-sheet")).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("workstation")).toBeVisible();
  await expect(composerConn(page)).toHaveAttribute("data-state", "connected", { timeout: 30_000 });
}
const me = (page: Page) => page.evaluate(async () => { const r = await fetch("/api/me", { credentials: "same-origin" }); return r.ok ? (await r.json()) as any : null; });
/** Two existing songs for this account (distinct project ids), the way autosave/publish leaves them on the server. */
const seedTwoSongs = (page: Page, tag: string) => page.evaluate(async ({ song, tag }) => {
  const csrf = decodeURIComponent(document.cookie.split("; ").find((c) => c.startsWith("gbk_csrf="))?.slice(9) ?? "");
  for (const n of [1, 2]) {
    const r = await fetch("/api/shares", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-gbk-csrf": csrf },
      body: JSON.stringify({ title: `Paywall ${tag} song ${n}`, project: { ...song, id: `prj_pw${tag}${n}${Date.now().toString(36)}`, name: `Paywall ${tag} song ${n}` }, public: false }) });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  }
}, { song: SONG, tag });
async function noHorizontalOverflow(page: Page) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, card: document.querySelector(".pw-card")?.getBoundingClientRect().right ?? 0 }));
  expect(o.sw).toBeLessThanOrEqual(o.iw); expect(o.card).toBeLessThanOrEqual(o.iw);
}
async function loadSong(page: Page) {
  await page.getByTestId("midi-file-input").setInputFiles(FIXTURE_MID);
  const asNew = page.getByTestId("midi-import-new"); if (await asNew.isVisible({ timeout: 5000 }).catch(() => false)) await asNew.click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).__gbkWorkstation.project.tracks.length), { timeout: 30_000 }).toBeGreaterThan(0);
}
async function exportBlocked(page: Page, kind: "midi" | "wav", downloads: string[]) {
  const check = page.waitForResponse((r) => r.url().includes("/api/paywall/check") && r.request().method() === "POST", { timeout: 20_000 });
  await (await studioReveal(page, `export-${kind}`)).click();
  const res = await check;
  expect(res.status()).toBe(402);
  // Read the contract with a fresh request: a CDP response body can be gone once the page drained it.
  const body = await page.evaluate(async (k) => (await fetch("/api/paywall/check", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "export", kind: k }) })).json(), kind);
  expect(body).toMatchObject({ code: "PRO_REQUIRED", reason: "export", paywall: { reason: "export", hard: true, default_plan: "pro_yearly", trial_days: 7 } });
  const modal = page.getByTestId("paywall-modal");
  await expect(modal).toBeVisible();
  await expect(modal).toHaveAttribute("data-reason", "export");
  await expect(modal).toHaveAttribute("data-kind", "hard");
  await expect(page.getByTestId("paywall-plan-pro_yearly")).toHaveClass(/sel/); // leads with yearly
  await expect(page.getByTestId("paywall-plan-pro_yearly")).toContainText("7 days free");
  await expect(page.getByTestId("paywall-cta")).toHaveText("Start 7-day free trial");
  await expect(page.getByTestId("paywall-dismiss")).toHaveCount(0); // hard: no ✕
  expect(downloads).toEqual([]);
  return body;
}

async function flow(page: Page, code: string, tag: string, shots: boolean) {
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  page.on("dialog", (d) => void d.accept()); // "Start a new song?" confirm
  const downloads: string[] = []; page.on("download", (d) => downloads.push(d.suggestedFilename()));
  await page.goto("/studio");
  await expect(page.getByTestId("workstation")).toBeVisible();
  await page.waitForTimeout(2500);
  await expect(page.getByTestId("paywall-modal")).toHaveCount(0); // no landing paywall (signed out)

  // --- signed out: export is blocked (server 402), nothing downloads.
  await loadSong(page);
  const b = await exportBlocked(page, "midi", downloads);
  expect(b.signed_in).toBe(false);
  await noHorizontalOverflow(page);
  if (shots) await page.screenshot({ path: `${SHOTS}/${tag}-export-paywall.png` });
  await page.getByTestId("paywall-continue").click(); // "Not now"
  await expect(page.getByTestId("paywall-modal")).toHaveCount(0);
  expect(downloads).toEqual([]);

  // --- signed in (free): still no landing paywall after the reload.
  await signIn(page, code);
  await page.waitForTimeout(2500);
  await expect(page.getByTestId("paywall-modal")).toHaveCount(0);
  const m0 = await me(page);
  expect(m0.pro).toBe(false); expect(m0.paywall.reason).toBeNull(); expect(m0.paywall.third_song_seen).toBe(false);

  // --- 3rd song: two songs exist; starting another shows the soft popup once.
  await seedTwoSongs(page, tag);
  await (await studioReveal(page, "new-project")).click();
  const modal = page.getByTestId("paywall-modal");
  await expect(modal).toBeVisible({ timeout: 20_000 });
  await expect(modal).toHaveAttribute("data-reason", "third_song");
  await expect(modal).toHaveAttribute("data-kind", "soft");
  await expect(page.getByTestId("paywall-dismiss")).toBeVisible();
  await expect(page.getByTestId("paywall-plan-pro_yearly")).toHaveClass(/sel/);
  await noHorizontalOverflow(page);
  if (shots) await page.screenshot({ path: `${SHOTS}/${tag}-third-song-popup.png` });
  await page.getByTestId("paywall-dismiss").click();
  await expect(modal).toHaveCount(0);
  await expect.poll(async () => (await me(page))?.paywall?.third_song_seen, { timeout: 15_000 }).toBe(true); // remembered per account
  expect((await me(page)).paywall.cooldown_until).toBeNull();
  await expect(page.getByTestId("composer-input")).toBeVisible(); // composer input stays reachable

  // Once only: another new song shows nothing, in this page and after a reload.
  await (await studioReveal(page, "new-project")).click();
  await page.waitForTimeout(3000);
  await expect(modal).toHaveCount(0);
  await page.evaluate(() => localStorage.removeItem("gbk.paywall.thirdSong.v1")); // server memory alone suffices
  await page.reload(); await expect(page.getByTestId("workstation")).toBeVisible();
  await (await studioReveal(page, "new-project")).click();
  await page.waitForTimeout(3000);
  await expect(modal).toHaveCount(0);

  // --- signed in, free: export still blocked; the CTA logs plan_select with reason export and opens /pricing.
  await loadSong(page);
  const b2 = await exportBlocked(page, "wav", downloads);
  expect(b2.signed_in).toBe(true);
  const planSelect = page.waitForRequest((r) => r.url().includes("/api/me/engagement") && (r.postDataJSON() as any)?.event === "plan_select", { timeout: 15_000 });
  await page.getByTestId("paywall-cta").click();
  const sel = (await planSelect).postDataJSON() as any;
  expect(sel).toMatchObject({ plan: "pro_yearly", reason: "export", surface: "studio", platform: "web" });
  await expect(page).toHaveURL(/\/pricing\?plan=pro_yearly&reason=export/, { timeout: 20_000 });
  expect(downloads).toEqual([]);
}

test("paywall desktop: no landing paywall, export blocked with 402, 3rd-song popup once, AI budget hard gate", async ({ page }) => {
  test.skip(test.info().project.name !== "chrome-no-webmcp", "desktop Chrome");
  await flow(page, "e2e-code-3", "desktop", true);
  // Hard AI-budget gate (a run failing on the budget): blocks with the reset time; Escape does not dismiss it.
  await page.goto("/studio"); await expect(page.getByTestId("workstation")).toBeVisible();
  const modal = page.getByTestId("paywall-modal");
  const budgetFail = () => page.evaluate(() => window.dispatchEvent(new CustomEvent("gbk:run-failed", { detail: { runId: "e2e-paywall", code: "TOKEN_BUDGET_EXHAUSTED", message: "budget" } })));
  await expect.poll(async () => { await budgetFail(); return modal.count(); }, { timeout: 30_000 }).toBe(1);
  await expect(modal).toHaveAttribute("data-reason", "ai_budget");
  await expect(modal).toHaveAttribute("data-kind", "hard");
  await expect(page.getByTestId("paywall-reset")).toContainText("resets at");
  await page.keyboard.press("Escape");
  await expect(modal).toBeVisible();
  await page.getByTestId("paywall-continue").click();
  await expect(modal).toHaveCount(0);
});

test("iphone paywall (mobile): no landing paywall, export blocked with 402, 3rd-song popup once and dismissible", async ({ page }) => {
  const name = test.info().project.name;
  test.skip(!name.startsWith("mobile"), "phones");
  await flow(page, name === "mobile-webkit" ? "e2e-code-5" : "e2e-code-6", name === "mobile-webkit" ? "iphone" : "pixel", true);
});
