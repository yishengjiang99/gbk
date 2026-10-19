import { expect, test, type Page } from "@playwright/test";

// Synthetic-input verification of the MIDI clock follower (no MIDI hardware needed).
// MIDI_CLOCK_SOAK_MS overrides the length of the steady-state run (default 20 s; the PR verification used 120 s).
const SOAK_MS = Number(process.env.MIDI_CLOCK_SOAK_MS ?? 20_000);

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

type Click = { beat: number; scheduledS: number; renderedS: number };

async function clicks(page: Page): Promise<Click[]> {
  const flat = await page.evaluate(() => (window as any).__midiClock.clicks() as number[]);
  const out: Click[] = [];
  for (let i = 0; i + 2 < flat.length; i += 3) out.push({ beat: flat[i], scheduledS: flat[i + 1], renderedS: flat[i + 2] });
  return out;
}

const status = (page: Page) => page.evaluate(() => (window as any).__midiClock.status());

test("synthetic 120 BPM source drives a synchronized click without duplicate beats", async ({ page }) => {
  test.setTimeout(SOAK_MS + 60_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("midi-clock.html");
  await page.locator("#power").click();
  await expect(page.locator("#power")).toHaveText("Audio on");

  // Start: first F8 after FA is tick 0, display shows BPM + phase.
  await page.locator("#synth-start").click();
  await expect.poll(async () => (await status(page))?.state, { timeout: 5000 }).toBe("running");
  await expect.poll(async () => Math.abs(((await status(page))?.bpm ?? 0) - 120), { timeout: 5000 }).toBeLessThan(0.5);
  await expect(page.locator("#bpm")).toHaveText(/^1(19|20)\.\d$/);
  await expect(page.locator("#phase-text")).toHaveText(/phase \d\.\d\d/);

  await page.waitForTimeout(SOAK_MS);
  let list = await clicks(page);
  const beats = list.map((c) => c.beat);
  expect(new Set(beats).size).toBe(beats.length); // no duplicate beats
  expect(list.length).toBeGreaterThanOrEqual(Math.floor(SOAK_MS / 500) - 1);
  expect(beats[0]).toBe(0);
  beats.forEach((b, i) => expect(b).toBe(i)); // no missing beats either
  // Beat 0 can only be heard after the Start message has travelled MIDI -> worker -> main -> worklet and the
  // audio output latency has elapsed, so it renders late; every later click is predicted and phase-aligned.
  const firstLateMs = (list[0].renderedS - list[0].scheduledS) * 1000;
  const gaps = list.slice(2).map((c, i) => (c.renderedS - list[i + 1].renderedS) * 1000);
  const worst = Math.max(...gaps.map((g) => Math.abs(g - 500)));
  console.log(`clicks=${list.length} beat0 late by ${firstLateMs.toFixed(1)} ms; worst |interval-500ms| after beat 1 = ${worst.toFixed(3)} ms`);
  expect(firstLateMs).toBeLessThan(120);
  expect(worst).toBeLessThan(10);

  // Stop: no further clicks.
  await page.locator("#synth-stop").click();
  await expect.poll(async () => (await status(page))?.state).toBe("stopped");
  await page.waitForTimeout(400);
  const afterStop = (await clicks(page)).length;
  await page.waitForTimeout(1500);
  expect((await clicks(page)).length).toBe(afterStop);

  // Continue: resumes without repeating beats already clicked.
  await page.locator("#synth-continue").click();
  await expect.poll(async () => (await status(page))?.state).toBe("running");
  await page.waitForTimeout(2600);
  list = await clicks(page);
  const all = list.map((c) => c.beat);
  console.log(`beats after continue: ${all.slice(-6).join(",")}`);
  // within a run beat numbers strictly increase (continue picks up the song position)
  const lastRun = all.slice(afterStop);
  lastRun.forEach((b, i) => { if (i > 0) expect(b).toBe(lastRun[i - 1] + 1); });
  expect(lastRun.length).toBeGreaterThanOrEqual(3);

  // Silence: sync loss is reported within 500 ms.
  const t0 = Date.now();
  await page.locator("#synth-silent").click();
  await expect.poll(async () => (await status(page))?.state, { timeout: 500 }).toBe("lost");
  console.log(`loss reported ${Date.now() - t0} ms after the last clock (wall time incl. polling)`);

  // Reconnect: sync restored, transport stays stopped until Start/Continue, no extra clicks.
  const beforeReconnect = (await clicks(page)).length;
  await page.locator("#synth-replug").click();
  await expect.poll(async () => (await status(page))?.state).toBe("stopped");
  await page.waitForTimeout(1200);
  expect((await clicks(page)).length).toBe(beforeReconnect);
  expect(errors).toEqual([]);
});
