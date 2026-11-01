// #187: opening/closing the on-screen keyboard on the phone studio must never show a white band.
// No real iPhone in CI, so in WebKit (iPhone 13) we simulate iOS: the visual viewport shrinks/pans frame by frame while the
// layout viewport lags (stale 100dvh), a fake keyboard covers the bottom, then the layout catches up. Rapid screenshots
// of every step are scanned for near-white full-width bands while the studio surface is dark.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const SHOTS = process.env.KBFLASH_SHOTS; // e.g. /workspace/shots/kbflash (optional frame dump)
const KB = 300;

async function setup(page: Page) {
  await page.addInitScript(() => {
    const real = window.visualViewport!; const fake = new EventTarget() as any; const s = { h: null as number | null, top: 0 };
    (window as any).__kb = s;
    for (const k of ["width", "offsetLeft", "pageLeft", "pageTop", "scale"]) Object.defineProperty(fake, k, { get: () => (real as any)[k] });
    Object.defineProperty(fake, "height", { get: () => s.h ?? real.height });
    Object.defineProperty(fake, "offsetTop", { get: () => s.top });
    real.addEventListener("resize", () => fake.dispatchEvent(new Event("resize")));
    Object.defineProperty(window, "visualViewport", { get: () => fake, configurable: true });
  });
  // Pretend the Composer server is there so the phone gets the chat studio (.ms) with the composer input.
  await page.route(/\/api\//, (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.goto("studio");
  await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 20_000 });
}

async function whiteBands(page: Page, png: Buffer): Promise<number> {
  return page.evaluate(async (b64) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const g = c.getContext("2d")!; g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data;
    let run = 0, worst = 0;
    for (let y = 0; y < c.height; y++) {
      let white = 0;
      for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) white++; }
      run = white > c.width * 0.9 ? run + 1 : 0; worst = Math.max(worst, run);
    }
    return worst; // tallest run of (almost) fully white rows, in device px
  }, png.toString("base64"));
}

async function step(page: Page, h: number, top: number, kb: number) {
  await page.evaluate(({ h, top, kb }) => {
    const s = (window as any).__kb; s.h = h; s.top = top;
    let k = document.getElementById("__fakekb");
    if (!k) { k = document.createElement("div"); k.id = "__fakekb"; k.style.cssText = "position:fixed;left:0;right:0;bottom:0;background:#3a3a3c;z-index:99999;pointer-events:none"; document.body.appendChild(k); }
    k.style.height = `${kb}px`;
    window.visualViewport!.dispatchEvent(new Event("resize")); window.visualViewport!.dispatchEvent(new Event("scroll"));
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, { h, top, kb });
}

for (const scheme of ["dark", "light"] as const) {
  test(`keyboard open/close never flashes a contrasting band (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await setup(page);
    const vp = page.viewportSize()!; const H = vp.height;
    const surface = await page.evaluate(() => getComputedStyle(document.querySelector(".ms")!).backgroundColor);
    const pageBg = await page.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor]);
    expect(pageBg).toEqual([surface, surface]); // nothing behind the shell can contrast with it
    await page.getByTestId("composer-input").focus();
    expect(await page.getByTestId("composer-input").evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(16);
    const frames: Buffer[] = [];
    const n = 8;
    const check = async (label: string) => {
      const png = await page.screenshot(); frames.push(png);
      if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); writeFileSync(`${SHOTS}/${scheme}-${String(frames.length).padStart(2, "0")}-${label}.png`, png); }
      if (scheme === "dark") expect(await whiteBands(page, png), `white band in frame ${frames.length} (${label})`).toBeLessThan(6);
      // composer input stays inside the visible (visual) viewport, above the keyboard
      const box = await page.getByTestId("composer-input").boundingBox(); const vv = await page.evaluate(() => ({ h: window.visualViewport!.height, t: window.visualViewport!.offsetTop }));
      expect(box, label).toBeTruthy();
      expect(box!.y + box!.height, label).toBeLessThanOrEqual(vv.t + vv.h + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal overflow").toBe(true);
    };
    await check("closed");
    // Open: visual viewport shrinks frame by frame while the layout viewport is still stale (old 100dvh).
    for (let i = 1; i <= n; i++) { const kb = Math.round((KB * i) / n); await step(page, H - kb, 0, kb); await check(`open${i}`); }
    // Safari may also pan the visual viewport (offsetTop); the fixed shell follows it so the composer stays in view.
    await step(page, H - KB, 120, KB);
    await expect.poll(() => page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector(".ms")!).transform).m42)).toBe(120);
    const pb = (await page.getByTestId("composer-input").boundingBox())!; expect(pb.y + pb.height).toBeLessThanOrEqual(120 + H - KB + 1); expect(pb.y).toBeGreaterThanOrEqual(120);
    // Layout catches up (interactive-widget=resizes-content), pan resets.
    await page.setViewportSize({ width: vp.width, height: H - KB }); await step(page, H - KB, 0, 0); await check("open-settled");
    // Close: layout viewport grows back first, keyboard slides away.
    await page.setViewportSize({ width: vp.width, height: H });
    for (let i = n - 1; i >= 0; i--) { const kb = Math.round((KB * i) / n); await step(page, H - kb, 0, kb); await check(`close${n - i}`); }
    await page.evaluate(() => { (window as any).__kb.h = null; window.visualViewport!.dispatchEvent(new Event("resize")); }); await check("closed-settled");
    const end = await page.evaluate(() => [document.documentElement.style.getPropertyValue("--vvh"), getComputedStyle(document.querySelector(".ms")!).height]);
    expect(end).toEqual([`${H}px`, `${H}px`]);
  });
}
