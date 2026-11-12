// Primary Fork button: on a read-only shared song it replaces Publish; a signed-out tap opens sign-in, then forks.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const ws = (page: Page) => page.evaluate(() => {
  const c = (globalThis as any).__gbkWorkstation;
  return { readOnly: c.readOnlyReason, id: c.project.id, name: c.project.name };
});
const compact = (page: Page) => page.getByTestId("workstation").getAttribute("data-compact");

async function dismissLandingPaywall(page: Page) {
  const modal = page.getByTestId("paywall-modal");
  try { await expect(modal).toBeVisible({ timeout: 8_000 }); } catch { return; }
  await page.getByTestId("paywall-later").click();
  await expect(modal).toHaveCount(0);
}

async function publishSong(page: Page, code: string, title: string): Promise<string> {
  const proj = JSON.parse(readFileSync("songs/2026-10-23-midnight-invention/project.json", "utf8"));
  return page.evaluate(async ({ proj, code, title }) => {
    const j = async (r: Response) => { if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); return r.json(); };
    const s = await j(await fetch("/api/session", { credentials: "same-origin" }));
    const l = await j(await fetch("/api/login", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-gbk-csrf": s.csrf }, body: JSON.stringify({ code }) }));
    const r = await j(await fetch("/api/shares", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-gbk-csrf": l.csrf }, body: JSON.stringify({ title, project: proj, public: true }) }));
    return r.slug as string;
  }, { proj, code, title });
}

async function deleteSong(page: Page, slug: string) {
  await page.evaluate(async (slug) => {
    const csrf = decodeURIComponent(document.cookie.split("; ").find((c) => c.startsWith("gbk_csrf="))?.slice(9) ?? "");
    const r = await fetch(`/api/shares/${encodeURIComponent(slug)}`, { method: "DELETE", credentials: "same-origin", headers: { "x-gbk-csrf": csrf } });
    if (!r.ok && r.status !== 404) throw new Error(`${r.status} ${await r.text()}`);
  }, slug);
}

async function closeSheet(page: Page) {
  if (await page.getByTestId("sheet-more").count()) {
    await page.getByTestId("studio-overflow").click({ timeout: 10_000 });
  }
  await expect(page.getByTestId("sheet-more")).toHaveCount(0);
}

async function expectPublish(page: Page) {
  await expect(page.getByTestId("studio-fork")).toHaveCount(0);
  if ((await compact(page)) === "1") {
    await page.getByTestId("studio-overflow").click({ timeout: 15_000 });
    await expect(page.getByTestId("more-publish")).toBeVisible();
    await expect(page.getByTestId("more-fork")).toHaveCount(0);
    await closeSheet(page);
  } else {
    await expect(page.getByTestId("studio-publish")).toBeVisible();
  }
}

async function expectFork(page: Page) {
  await expect(page.getByTestId("studio-fork")).toBeVisible();
  await expect(page.getByTestId("studio-publish")).toHaveCount(0);
  await expect(page.getByTestId("fork-btn")).toHaveCount(0);
  if ((await compact(page)) === "1") {
    await page.getByTestId("studio-overflow").click({ timeout: 15_000 });
    await expect(page.getByTestId("more-fork")).toBeVisible();
    await expect(page.getByTestId("more-publish")).toHaveCount(0);
    await closeSheet(page);
  }
}

async function composerFits(page: Page) {
  const input = page.getByTestId("composer-input");
  await expect(input).toBeVisible();
  const r = await input.evaluate((e) => {
    const b = e.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + Math.min(20, b.width / 2), b.top + b.height / 2);
    const d = document.scrollingElement!;
    return {
      onScreen: b.top >= 0 && b.bottom <= innerHeight + 1 && b.left >= 0 && b.right <= innerWidth + 1,
      reachable: !!hit && (hit === e || e.contains(hit) || e.closest("[data-testid=composer-bar]")?.contains(hit)),
      font: getComputedStyle(e).fontSize,
      overflowX: d.scrollWidth - innerWidth,
      overflowY: d.scrollHeight - innerHeight,
    };
  });
  expect(r.onScreen, "composer input on screen").toBe(true);
  expect(r.reachable, "composer input not covered").toBe(true);
  expect(r.font).toBe("16px");
  expect(r.overflowX, "no horizontal overflow").toBeLessThanOrEqual(0);
  return r;
}

test("primary Fork button: owner sees Publish, non-owner sees Fork, signed-out fork signs in then forks (desktop + mobile)", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const title = `Fork Button ${Date.now()}`;
  const owner = await browser.newContext();
  const op = await owner.newPage();
  let slug = "";
  try {
    await op.goto("/studio");
    slug = await publishSong(op, "e2e-code", title);
    await op.goto("/studio");
    await expect(op.getByTestId("workstation")).toBeVisible();
    await dismissLandingPaywall(op);
    await expectPublish(op);
    await composerFits(op);

    await page.goto(`/s/${slug}?edit=1`);
    await expect(page.getByTestId("workstation")).toBeVisible();
    await expect(page.getByTestId("readonly-banner")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("readonly-banner")).toContainText(title);
    await expect.poll(async () => (await ws(page)).readOnly, { timeout: 20_000 }).toBeTruthy();
    await expectFork(page);
    await composerFits(page);
    if ((await compact(page)) !== "1") {
      const y = await page.evaluate(() => document.scrollingElement!.scrollHeight - innerHeight);
      expect(y, "desktop studio no vertical page scroll").toBeLessThanOrEqual(0);
    }

    await page.getByTestId("studio-fork").click({ timeout: 15_000 });
    const sheet = page.getByTestId("signin-sheet");
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId("signin-why")).toContainText(/fork/i);
    await sheet.getByTestId("signin-code").fill("e2e-code-2");
    await sheet.getByTestId("signin-code-submit").click();
    await expect(sheet).toBeHidden({ timeout: 15_000 });
    await page.waitForLoadState("load");
    await expect(page.getByTestId("workstation")).toBeVisible();
    await dismissLandingPaywall(page);
    // After reload the blank studio is briefly writable; wait until the share has been opened and forked.
    await expect.poll(async () => (await ws(page)).name, { timeout: 20_000 }).toMatch(/\(fork\)$/);
    expect((await ws(page)).readOnly).toBeNull();
    await expectPublish(page);
    await composerFits(page);
  } finally {
    if (slug) await deleteSong(op, slug).catch(() => undefined);
    await owner.close();
  }
});
