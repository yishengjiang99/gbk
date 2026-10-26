// Desktop studio grid (DesktopStudio, >=500px, not the iOS app): fits the viewport, agent input always visible,
// piano-roll zoom (buttons, sliders, Ctrl/⌘+wheel, Alt+wheel, fit) and track focus with ghost notes.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
const SHOTS = process.env.GBK_SHOTS ?? "/workspace/shots";
mkdirSync(SHOTS, { recursive: true });
test.beforeEach(() => { test.skip(test.info().project.name !== "chrome-no-webmcp", "desktop Chrome"); });

const seed = (page: Page) => page.evaluate(async () => { const c = (globalThis as any).__gbkWorkstation;
  await c.createProject({ name: "Desktop grid E2E", owner: "user", replaceCurrent: true });
  c.edit([{ op: "addTrack", name: "Melody", channel: 0, id: "t_mel", program: 0 }, { op: "addTrack", name: "Bass", channel: 1, id: "t_bass", program: 33 },
    { op: "addNotes", notes: [72, 74, 76, 79, 77, 76, 74, 72].map((p, i) => ({ trackId: "t_mel", channel: 0, tick: i * 480, duration: 440, pitch: p, velocity: 90 })) },
    { op: "addNotes", notes: [36, 43, 45, 40].map((p, i) => ({ trackId: "t_bass", channel: 1, tick: 7680 + i * 960, duration: 900, pitch: p, velocity: 100 })) }], { label: "seed" }); });
const roll = (page: Page) => page.getByTestId("piano-roll").locator("..");
const ppt = async (page: Page) => +(await roll(page).getAttribute("data-px-per-tick"))!;
const range = async (page: Page) => (await roll(page).getAttribute("data-pitch-range"))!.split("-").map(Number);
async function open(page: Page, w: number, h: number, scheme: "light" | "dark" = "light") {
  await page.emulateMedia({ colorScheme: scheme }); await page.setViewportSize({ width: w, height: h });
  await page.goto("/studio"); await expect(page.getByTestId("workstation")).toHaveAttribute("data-layout", "grid");
}
/** The agent input is on screen, not covered, 16px. */
async function inputVisible(page: Page, label: string) {
  const r = await page.getByTestId("composer-input").evaluate((e) => { const b = e.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return [b.top >= 0, b.bottom <= innerHeight, b.left >= 0, b.right <= innerWidth, !!hit && (hit === e || e.contains(hit)), getComputedStyle(e).fontSize].join(","); });
  expect(r, label).toBe("true,true,true,true,true,16px");
}
const noScroll = (page: Page) => page.evaluate(() => { const d = document.scrollingElement!; return { v: d.scrollHeight - innerHeight, h: d.scrollWidth - innerWidth }; });

test("desktop studio grid: no page scroll at 1280x800 and 1440x900 (light + dark), agent input visible, 16px inputs, no Sign in button", async ({ page }) => {
  for (const [w, h] of [[1280, 800], [1440, 900]]) for (const scheme of ["light", "dark"] as const) {
    await open(page, w, h, scheme);
    expect(await noScroll(page), `${w}x${h} ${scheme}`).toEqual({ v: 0, h: 0 });
    await page.mouse.wheel(0, 1500); expect(await page.evaluate(() => scrollY)).toBe(0);
    await inputVisible(page, `${w}x${h} ${scheme}`);
    await expect(page.getByRole("button", { name: /sign in/i })).toHaveCount(0);
    // grid areas: header 70px; sidebar = 1/4 of the width; footer spans the full width
    const g = await page.evaluate(() => { const r = (s: string) => document.querySelector(s)!.getBoundingClientRect(); return { head: r(".ds-head").height, side: r(".ds-side").width, main: r(".ds-main").width, foot: r(".ds-foot").width }; });
    expect(g.head).toBe(70); expect(Math.abs(g.side * 3 - g.main)).toBeLessThan(4); expect(g.foot).toBe(w);
    const bg = await page.getByTestId("workstation").evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(bg).toBe(scheme === "light" ? "rgb(255, 255, 255)" : "rgb(13, 15, 20)");
    for (const id of ["studio-title", "bpm-input", "patch-search"]) expect(await page.getByTestId(id).evaluate((e) => getComputedStyle(e).fontSize), id).toBe("16px");
    // key / time signature / tap in the header from 1280px up
    await expect(page.getByTestId("ts-select")).toBeVisible(); await expect(page.getByTestId("key-select")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/studio-grid-local-${w}-${scheme}.png` });
  }
  await open(page, 1200, 800); expect(await noScroll(page)).toEqual({ v: 0, h: 0 });
  await expect(page.getByTestId("ts-select")).toHaveCount(0);
  await page.getByTestId("studio-overflow").click(); await expect(page.getByTestId("more-tempo-meter").getByTestId("ts-select")).toBeVisible();
  await expect(page.getByTestId("more-tempo-meter").getByTestId("key-select")).toBeVisible(); await expect(page.getByTestId("more-tempo-meter").getByTestId("bpm-tap")).toBeVisible();
  await inputVisible(page, "1200 menu open");
});

test("desktop studio grid: time + pitch zoom (buttons, sliders, Ctrl+wheel, Alt+wheel, fit) and the automation lane follows the roll", async ({ page }) => {
  await open(page, 1440, 900); await seed(page);
  const p0 = await ppt(page);
  await page.getByTestId("zoom-time-in").click(); await expect.poll(() => ppt(page)).toBeGreaterThan(p0 * 1.2);
  const p1 = await ppt(page); await page.getByTestId("zoom-time-out").click(); await expect.poll(() => ppt(page)).toBeLessThan(p1);
  await page.getByTestId("zoom-time").fill("80"); await expect.poll(() => ppt(page)).toBeGreaterThan(0.3);
  const [lo0, hi0] = await range(page);
  await page.getByTestId("zoom-pitch-in").click(); await expect.poll(async () => { const [lo, hi] = await range(page); return hi - lo; }).toBeLessThan(hi0 - lo0);
  const b = (await page.getByTestId("piano-roll").boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  const p2 = await ppt(page); await page.keyboard.down("Control"); await page.mouse.wheel(0, -200); await page.keyboard.up("Control");
  await expect.poll(() => ppt(page)).toBeGreaterThan(p2);
  const [lo1, hi1] = await range(page); await page.keyboard.down("Alt"); await page.mouse.wheel(0, 200); await page.keyboard.up("Alt");
  await expect.poll(async () => { const [lo, hi] = await range(page); return hi - lo; }).toBeGreaterThan(hi1 - lo1);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await page.getByTestId("zoom-fit").click();
  const [lo2, hi2] = await range(page); expect(lo2).toBeLessThanOrEqual(36); expect(hi2).toBeGreaterThanOrEqual(79);
  // the automation lane uses the roll's view: drawing in it at the same x lands at the same tick
  await page.getByTestId("track-Melody").getByTestId("track-focus").click(); await page.getByTestId("lane-select").selectOption("11");
  const lane = page.getByTestId("lane-11").locator("canvas"); const lb = (await lane.boundingBox())!;
  const v = await page.evaluate(() => { const r = document.querySelector("[data-testid=piano-roll]")!.parentElement!; return { scroll: +r.dataset.scrollTick!, ppt: +r.dataset.pxPerTick! }; });
  await lane.click({ position: { x: 36 + 200, y: lb.height / 2 } });
  const cc = await page.evaluate(() => (globalThis as any).__gbkWorkstation.project.ccs.filter((c: any) => c.controller === 11 && c.trackId === "t_mel").map((c: any) => c.tick));
  expect(cc).toHaveLength(1); expect(Math.abs(cc[0] - (v.scroll + 200 / v.ppt))).toBeLessThan(2 / v.ppt + 1);
  await inputVisible(page, "after zoom");
});

test("desktop studio grid: clicking a track focuses it and zooms to its range (ghost notes); Show all tracks returns; draw / erase / BPM edit the real project", async ({ page }) => {
  await open(page, 1440, 900); await seed(page);
  await page.getByTestId("track-Bass").getByTestId("track-focus").click();
  await expect(roll(page)).toHaveAttribute("data-focus-track", "t_bass");
  await expect(page.getByTestId("focus-chip")).toHaveText("Focused: Bass");
  await expect(page.getByTestId("track-Bass")).toHaveAttribute("data-focused", "1");
  const [lo, hi] = await range(page); expect(lo).toBeLessThanOrEqual(36); expect(hi).toBeGreaterThanOrEqual(45); expect(hi).toBeLessThan(72); // melody (72+) is out of range
  const scroll = +(await roll(page).getAttribute("data-scroll-tick"))!; expect(scroll).toBeGreaterThan(7000); // bass starts at bar 5
  await page.screenshot({ path: `${SHOTS}/studio-grid-local-focus-bass.png` });
  // draw a note into the focused track (click-drag sets the length), then erase it
  const b = (await page.getByTestId("piano-roll").boundingBox())!;
  const n0 = await page.evaluate(() => (globalThis as any).__gbkWorkstation.project.notes.length);
  await page.mouse.move(b.x + b.width * 0.8, b.y + 20); await page.mouse.down(); await page.mouse.move(b.x + b.width * 0.9, b.y + 20, { steps: 4 }); await page.mouse.up();
  const drawn = await page.evaluate(() => { const p = (globalThis as any).__gbkWorkstation.project; return { n: p.notes.length, last: p.notes.filter((x: any) => x.velocity === 96).map((x: any) => ({ t: x.trackId, d: x.duration })) }; });
  expect(drawn.n).toBe(n0 + 1); expect(drawn.last[0].t).toBe("t_bass"); expect(drawn.last[0].d).toBeGreaterThan(120);
  await page.getByTestId("tool-erase").click(); await page.mouse.click(b.x + b.width * 0.8 + 3, b.y + 20 + 2);
  await expect.poll(() => page.evaluate(() => (globalThis as any).__gbkWorkstation.project.notes.length)).toBe(n0);
  await page.getByTestId("studio-undo").click(); await expect.poll(() => page.evaluate(() => (globalThis as any).__gbkWorkstation.project.notes.length)).toBe(n0 + 1);
  await page.getByTestId("show-all").click();
  await expect(roll(page)).toHaveAttribute("data-focus-track", ""); await expect(page.getByTestId("focus-chip")).toHaveText("All tracks");
  const [lo3, hi3] = await range(page); expect(lo3).toBeLessThanOrEqual(36); expect(hi3).toBeGreaterThanOrEqual(79);
  await page.getByTestId("bpm-up").click();
  await expect.poll(() => page.evaluate(() => Math.round(60e6 / (globalThis as any).__gbkWorkstation.project.tempos[0].microPerQuarter))).toBe(121);
  await page.getByTestId("track-Melody").getByTestId("track-focus").click(); await page.getByTestId("patch-search").fill("violin"); await page.getByTestId("patch").first().click();
  await expect.poll(() => page.evaluate(() => (globalThis as any).__gbkWorkstation.project.programs.find((x: any) => x.trackId === "t_mel")?.program)).toBe(40);
});

test("desktop studio grid: automation Read/Write drive playback, the metronome clicks the first beat, the ruler seeks (follows zoom + scroll)", async ({ page }) => {
  await open(page, 1440, 900); await seed(page);
  await page.evaluate(() => (globalThis as any).__gbkWorkstation.edit([{ op: "setCC", trackId: "t_mel", channel: 0, controller: 11, startTick: 0, endTick: 1920, mode: "replace", points: [{ tick: 0, value: 30 }, { tick: 1920, value: 120 }] }], { label: "cc11" }));
  const pos = () => page.evaluate(() => (globalThis as any).__gbkWorkstation.getState().transport.positionTick as number);
  const playing = () => page.evaluate(() => (globalThis as any).__gbkWorkstation.getState().transport.playing as boolean);
  const lanes = () => page.evaluate(() => ((globalThis as any).__gbkPlayerLoad?.ccLanes ?? null) as Record<string, number> | null);

  // ruler: click seeks to the tick under the pointer (roll view: key strip + scroll + zoom), drag follows
  const ruler = page.getByTestId("roll-ruler").locator("canvas");
  const view = () => page.evaluate(() => { const r = document.querySelector("[data-testid=piano-roll]")!.parentElement!; return { scroll: +r.dataset.scrollTick!, ppt: +r.dataset.pxPerTick! }; });
  const rb = (await ruler.boundingBox())!;
  const expectAt = async (x: number) => { const v = await view(); const tk = v.scroll + (x - 36) / v.ppt; await expect.poll(pos).toBeGreaterThan(tk - 121); expect(Math.abs((await pos()) - tk)).toBeLessThanOrEqual(120 + 1); };
  await ruler.click({ position: { x: 336, y: rb.height / 2 } }); await expectAt(336);
  await page.getByTestId("zoom-time-in").click(); await page.getByTestId("zoom-time-in").click();
  await ruler.click({ position: { x: 236, y: rb.height / 2 } }); await expectAt(236);
  await page.mouse.move(rb.x + 236, rb.y + rb.height / 2); await page.mouse.down(); await page.mouse.move(rb.x + 536, rb.y + rb.height / 2, { steps: 5 }); await page.mouse.up(); await expectAt(536);
  await page.getByTestId("zoom-fit").click();

  // metronome on, play from bar 1: the first click is the downbeat at the start
  await page.evaluate(() => (globalThis as any).__gbkWorkstation.seek(0)); await expect.poll(pos).toBe(0);
  await page.getByTestId("metro-toggle").click();
  await page.getByTestId("track-Melody").getByTestId("track-focus").click(); await page.getByTestId("lane-select").selectOption("11");
  await page.getByTestId("ws-play").click(); await expect.poll(playing, { timeout: 120_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => (globalThis as any).__gbkMetronome.clickTicks.length as number)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (globalThis as any).__gbkMetronome.clickTicks[0] as number)).toBeLessThan(480 * 0.3);
  // Read on: the lane's CCs reach the engine; Read off: the song is re-sent without them and keeps playing
  expect((await lanes())?.["t_mel:11"]).toBe(2);
  await expect(page.getByTestId("lane-read")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("lane-read").click(); await expect(page.getByTestId("lane-read")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await lanes())?.["t_mel:11"] ?? 0).toBe(0);
  await expect.poll(playing).toBe(true);
  await page.getByTestId("lane-read").click(); await expect.poll(async () => (await lanes())?.["t_mel:11"] ?? 0).toBe(2);
  // Write: slider moves during playback are recorded into the lane at the playhead (one take, committed on pause)
  await page.getByTestId("lane-write").click();
  const t0 = await pos();
  for (const v of [10, 60, 110]) { await page.getByTestId("lane-value").fill(String(v)); await page.waitForTimeout(250); }
  await page.getByTestId("ws-play").click(); await expect.poll(playing).toBe(false);
  const written = await page.evaluate((t0) => (globalThis as any).__gbkWorkstation.project.ccs.filter((c: any) => c.trackId === "t_mel" && c.controller === 11 && c.tick >= t0).map((c: any) => c.value), t0);
  expect(written).toEqual(expect.arrayContaining([10, 60, 110]));
  await page.getByTestId("lane-write").click();
});

test("desktop studio grid: plain wheel zooms time at the cursor, Shift+wheel zooms pitch, hovering an edge pans with a visible cue", async ({ page }) => {
  for (const scheme of ["light", "dark"] as const) {
    await open(page, 1440, 900, scheme); await seed(page);
    await page.evaluate(() => localStorage.removeItem("gbk.rollZoomHint")); await page.reload(); await expect(page.getByTestId("workstation")).toHaveAttribute("data-layout", "grid"); await seed(page);
    await expect(page.getByTestId("roll-hint")).toBeVisible();
    const b = (await page.getByTestId("piano-roll").boundingBox())!;
    const cx = b.x + 36 + 300, cy = b.y + b.height / 2;
    await page.mouse.move(cx, cy);
    const tickAt = async () => { const r = roll(page); return +(await r.getAttribute("data-scroll-tick"))! + 300 / +(await r.getAttribute("data-px-per-tick"))!; };
    const p0 = await ppt(page), t0 = await tickAt();
    await page.mouse.wheel(0, -300); await expect.poll(() => ppt(page)).toBeGreaterThan(p0 * 1.5);
    await expect(page.getByTestId("roll-zoom-toast")).toBeVisible(); await expect(page.getByTestId("roll-hint")).toHaveCount(0);
    expect(Math.abs((await tickAt()) - t0)).toBeLessThan(20 / (await ppt(page)) + 2); // anchored at the cursor (rounding of scroll-tick)
    expect(await page.evaluate(() => scrollY)).toBe(0);
    const p1 = await ppt(page); await page.mouse.wheel(0, 300); await expect.poll(() => ppt(page)).toBeLessThan(p1);
    const [lo0, hi0] = await range(page); await page.keyboard.down("Shift"); await page.mouse.wheel(0, -300); await page.keyboard.up("Shift");
    await expect.poll(async () => { const [lo, hi] = await range(page); return hi - lo; }).toBeLessThan(hi0 - lo0);
    // edge hover: right edge pans later in time, cue + cursor shown; leaving stops
    await page.getByTestId("zoom-time").fill("70");
    const s0 = +(await roll(page).getAttribute("data-scroll-tick"))!;
    await page.mouse.move(b.x + b.width - 6, cy);
    await expect(page.getByTestId("roll-edge-right")).toHaveAttribute("data-active", "1");
    expect(await page.getByTestId("piano-roll").evaluate((e) => getComputedStyle(e).cursor)).toBe("e-resize");
    await expect.poll(async () => +(await roll(page).getAttribute("data-scroll-tick"))!).toBeGreaterThan(s0 + 50);
    await page.screenshot({ path: `${SHOTS}/pianoroll-zoompan-${scheme}.png` });
    await page.mouse.move(b.x + b.width / 2, cy); await expect(page.getByTestId("roll-edge-right")).toHaveAttribute("data-active", "0");
    const s1 = +(await roll(page).getAttribute("data-scroll-tick"))!; await page.waitForTimeout(300); expect(+(await roll(page).getAttribute("data-scroll-tick"))!).toBe(s1);
    // left edge pans back and stops at 0
    await page.mouse.move(b.x + 36 + 3, cy); await expect.poll(async () => +(await roll(page).getAttribute("data-scroll-tick"))!, { timeout: 15000 }).toBe(0);
    // top edge pans up in pitch
    const [, hiT] = await range(page); await page.mouse.move(cx, b.y + 4);
    await expect.poll(async () => (await range(page))[1]).toBeGreaterThan(Math.min(126, hiT));
    await page.mouse.move(cx, cy);
  }
});
