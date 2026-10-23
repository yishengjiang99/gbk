import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { openAppMenu } from "./app-menu.ts";
// Every MIDI entry point must land in the workstation (notes + lanes) and the cursor must follow playback.
const BASE = process.env.GBK_URL ?? "/gbk/";
async function openPlayer(p: Page) { await p.getByTestId("open-player").click(); await expect(p.getByTestId("player-modal")).toHaveClass(/open/); }
async function closePlayer(p: Page) { await p.getByTestId("close-player").dispatchEvent("click"); }
async function wsName(p: Page) { return (await p.locator(".ws-name").textContent()) ?? ""; }
async function noteCount(p: Page) { return p.evaluate(() => [...document.querySelectorAll("[data-testid^=track-] .ws-dim")].reduce((s, e) => s + Number((e.textContent ?? "").split("·")[1] ?? 0), 0)); }

test("entry points: playlist, upload, stored file, Bach generator, recorder", async ({ page }) => {
  test.setTimeout(240_000); page.setDefaultTimeout(20_000);
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE);
  // 1. playlist
  await openPlayer(page); await page.getByText(/habanera/i).first().click(); await closePlayer(page);
  await expect(page.locator(".ws-name")).toContainText(/habanera/i); expect(await noteCount(page)).toBeGreaterThan(100);
  await expect(page.locator(".ws-lane").first()).toBeVisible();
  // cursor follows playback
  await page.getByTestId("ws-play").click();
  await expect.poll(async () => (await page.getByTestId("ws-pos").innerText()).match(/([\d.]+)s/)?.[1] ?? "0", { timeout: 60_000 }).not.toBe("0.00");
  await page.getByRole("button", { name: "Pause" }).first().click();
  // 2. upload
  await openPlayer(page);
  await page.locator('input[type=file][accept=".mid,.midi"]').first().setInputFiles({ name: "upload-test.mid", mimeType: "audio/midi", buffer: readFileSync("public/static/minor_works_hess-233c_(c)unheard-beethoven.mid") });
  await closePlayer(page);
  await expect(page.locator(".ws-name")).toContainText("upload-test"); expect(await noteCount(page)).toBeGreaterThan(10);
  // 3. stored file (IndexedDB) after reload: pick another song, then the stored upload again
  await page.reload(); await openPlayer(page); await page.getByText(/habanera/i).first().click(); await closePlayer(page);
  await expect(page.locator(".ws-name")).toContainText(/habanera/i);
  await openPlayer(page); await page.getByRole("button", { name: "upload-test.mid" }).first().click(); await closePlayer(page);
  await expect(page.locator(".ws-name")).toContainText("upload-test");
  // 4. Bach generator
  await openPlayer(page); await openAppMenu(page);
  await page.getByRole("button", { name: /Bach Composer/i }).click();
  await page.getByRole("button", { name: "Generate Bach Music" }).click();
  await expect(page.getByText("Generated Bach Soprano", { exact: true }).first()).toBeAttached({ timeout: 30_000 });
  await closePlayer(page);
  await expect(page.locator(".ws-name")).toContainText(/bach|fugue/i, { timeout: 30_000 }); expect(await noteCount(page)).toBeGreaterThan(20);
  // 5. recorder output (no hardware: drive the recorder through the converter path the button uses)
  const name = await page.evaluate(async () => {
    const { recorderEventsToSmf } = await import("/gbk/src/workstation/recording.ts" as string).catch(() => ({ recorderEventsToSmf: null as never }));
    return recorderEventsToSmf ? "dev" : "prod";
  });
  if (name === "dev") {
    await page.evaluate(async () => {
      const { recorderEventsToSmf } = await import("/gbk/src/workstation/recording.ts" as string);
      const { playerBridge } = await import("/gbk/src/workstation/player-bridge.ts" as string);
      const b = recorderEventsToSmf([{ deltaMs: 0, bytes: [0x90, 64, 90] }, { deltaMs: 100, bytes: [0xb0, 1, 70] }, { deltaMs: 200, bytes: [0xd0, 40] }, { deltaMs: 600, bytes: [0x80, 64, 0] }]);
      playerBridge.handle.loadBuffer(b.buffer.slice(0), "Recording test.mid", { autoplay: false, restoreSec: 0 });
    });
    await expect(page.locator(".ws-name")).toContainText("Recording test");
    await expect(page.getByTestId("lane-pressure")).toBeVisible();
    await expect(page.getByTestId("lane-1")).toBeVisible();
  }
  expect(errors).toEqual([]);
});
