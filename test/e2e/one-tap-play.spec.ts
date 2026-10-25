import { test, expect } from "@playwright/test";
// iPhone: one tap on Play must start playback, even on a cold load (SoundFont not yet downloaded). iOS only unlocks
// audio when AudioContext.resume() runs synchronously inside the tap, so we record whether it did.
const BASE = process.env.GBK_URL ?? "/gbk/";
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
  // Chromium: enforce the gesture requirement like iOS does (WebKit enforces it already).
  launchOptions: async ({ browserName }, use) => use(browserName === "chromium" ? { args: ["--autoplay-policy=document-user-activation-required"] } : {}) });

test("single tap on Play starts playback on a cold load", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const w = window as any; w.__inTap = false; w.__resumeInTap = 0; w.__resumeLate = 0;
    addEventListener("click", () => { w.__inTap = true; }, true);
    addEventListener("click", () => { w.__inTap = false; }, false);
    const OrigAC = AudioContext; w.__acStates = []; (window as any).AudioContext = class extends OrigAC { constructor(...a: any[]) { super(...a); w.__acStates.push(this.state + (w.__inTap ? "@tap" : "@late")); } };
    const orig = OrigAC.prototype.resume;
    OrigAC.prototype.resume = function (this: AudioContext) { if (w.__inTap) w.__resumeInTap++; else w.__resumeLate++; return orig.call(this); };
  });
  await page.goto(BASE);
  await page.waitForFunction(() => !!(globalThis as any).__gbkWorkstation);
  await page.evaluate(async () => {
    const ws = (globalThis as any).__gbkWorkstation;
    await ws.createProject({ name: "Tap", owner: "user", replaceCurrent: true });
    ws.edit([{ op: "addTrack", name: "Piano", channel: 0, id: "t_p", program: 0 }], { label: "seed" });
    ws.edit([{ op: "addNotes", notes: Array.from({ length: 32 }, (_, i) => ({ trackId: "t_p", channel: 0, tick: i * ws.project.ppq / 2, duration: ws.project.ppq / 2, pitch: 60 + (i % 12), velocity: 96 })) }], { label: "notes" });
  });
  const play = page.getByTestId("transport-row").getByRole("button", { name: "Play" });
  await play.tap();
  // Repeated taps while loading must not toggle it back off.
  await expect(page.getByTestId("transport-row").getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 90_000 });
  // Audio was unlocked inside the tap: the context was created (running) or resumed synchronously in the gesture.
  expect(await page.evaluate(() => { const w = window as any; return w.__resumeInTap > 0 || w.__acStates.some((x: string) => x === "running@tap"); })).toBe(true);
  expect(await page.evaluate(() => (window as any).__gbkWorkstation.state.transport.playing)).toBe(true);
  await page.waitForTimeout(1500);
  const pos = await page.getByTestId("ws-pos").first().getAttribute("data-pos-tick");
  expect(Number(pos)).toBeGreaterThan(0);
});

test("extra taps while the sound is loading never toggle playback back off", async ({ page }) => {
  test.setTimeout(120_000);
  page.on("dialog", (d) => { console.log("dialog:", d.message()); void d.dismiss(); }); page.on("console", (m) => { if (m.type() === "error") console.log("console:", m.text().slice(0, 200)); });
  await page.goto(BASE);
  await page.waitForFunction(() => !!(globalThis as any).__gbkWorkstation);
  await page.evaluate(async () => {
    const ws = (globalThis as any).__gbkWorkstation;
    await ws.createProject({ name: "Tap2", owner: "user", replaceCurrent: true });
    ws.edit([{ op: "addTrack", name: "Piano", channel: 0, id: "t_p", program: 0 }], { label: "seed" });
    ws.edit([{ op: "addNotes", notes: Array.from({ length: 32 }, (_, i) => ({ trackId: "t_p", channel: 0, tick: i * ws.project.ppq / 2, duration: ws.project.ppq / 2, pitch: 60 + (i % 12), velocity: 96 })) }], { label: "notes" });
  });
  const row = page.getByTestId("transport-row");
  await row.getByRole("button", { name: "Play" }).tap();
  // A second Play request while the first is still starting shares it (never toggles off).
  await page.evaluate(() => { void (globalThis as any).__gbkWorkstation.play(); void (globalThis as any).__gbkWorkstation.play(); });
  try { await expect(row.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 20_000 }); }
  catch (e) { console.log("DEBUG", JSON.stringify(await page.evaluate(() => ({ t: (globalThis as any).__gbkWorkstation.state.transport, modal: document.querySelector("[data-testid=player-modal]")?.textContent?.slice(0, 600) })))); throw e; }
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => (window as any).__gbkWorkstation.state.transport.playing)).toBe(true);
});
