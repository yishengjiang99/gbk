import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { openAppMenu, waitForSf2Ready } from "./app-menu.ts";

function loudChordMidi(): Buffer {
  const events = [0, 0xc0, 61]; // Brass section; a short, deliberately loud tutti.
  for (let note = 48; note < 72; note++) events.push(0, 0x90, note, 127);
  for (let note = 48; note < 72; note++) events.push(...(note === 48 ? [0x8f, 0] : [0]), 0x80, note, 0);
  events.push(0, 0xff, 0x2f, 0);
  const header = Buffer.from([77, 84, 104, 100, 0, 0, 0, 6, 0, 0, 0, 1, 1, 224]);
  const track = Buffer.alloc(8);
  track.write("MTrk");
  track.writeUInt32BE(events.length, 4);
  return Buffer.concat([header, track, Buffer.from(events)]);
}

test("browser AudioWorklet and offline mastering produce the same stereo samples", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const moduleUrl = new URL("./src/master-dynamics.ts", location.href).href;
    const workletUrl = new URL("./src/master-dynamics-processor.ts?worker&url", location.href).href;
    const { applyMasterDynamicsToBuffer, MasterDynamics } = await import(moduleUrl);
    const { default: processorUrl } = await import(workletUrl);
    const sampleRate = 48000;
    const length = 17003;
    const delay = new MasterDynamics(sampleRate, "epic").latencyFrames;
    const ctx = new OfflineAudioContext(2, length + delay, sampleRate);
    await ctx.audioWorklet.addModule(processorUrl);
    const source = ctx.createBufferSource();
    const buffer = ctx.createBuffer(2, length, sampleRate);
    for (let i = 0; i < length; i++) {
      buffer.getChannelData(0)[i] = 3 * Math.sin(2 * Math.PI * 440 * i / sampleRate);
      buffer.getChannelData(1)[i] = 0.5 * Math.sin(2 * Math.PI * 220 * i / sampleRate);
    }
    buffer.getChannelData(0)[length - 1] = 5;
    source.buffer = buffer;
    const node = new AudioWorkletNode(ctx, "master-dynamics", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { mode: "epic" },
    });
    source.connect(node).connect(ctx.destination);
    source.start();
    const actual = await ctx.startRendering();
    await applyMasterDynamicsToBuffer(buffer, "epic");
    let difference = 0;
    let peak = 0;
    for (let ch = 0; ch < 2; ch++) {
      const output = actual.getChannelData(ch);
      const expected = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        difference = Math.max(difference, Math.abs(output[i + delay] - expected[i]));
        peak = Math.max(peak, Math.abs(output[i + delay]));
      }
    }
    return { difference, peak };
  });
  expect(result.difference).toBeLessThan(1e-6);
  expect(result.peak).toBeGreaterThan(0.1);
  expect(result.peak).toBeLessThanOrEqual(10 ** (-1 / 20) + 1e-7);
});

test("orchestral controls persist and live keyboard audio reaches the processed analyzer", async ({ page }) => {
  await page.goto("/");
  await waitForSf2Ready(page);
  const mode = page.getByLabel("Dynamic compression", { exact: true });
  await expect(mode).toHaveValue("epic");
  await mode.selectOption("gentle");
  await page.reload();
  await expect(mode).toHaveValue("gentle");
  await waitForSf2Ready(page);
  await expect(page.getByRole("button", { name: "Export WAV", exact: true })).toBeEnabled();
  await mode.selectOption("off");
  await openAppMenu(page);
  await page.getByRole("button", { name: "Power On", exact: true }).click();
  await expect(page.locator(".statusDock")).toContainText("Audio: running");
  await page.locator("h2").first().click(); // Move keyboard focus off the select.
  await page.keyboard.down("a");
  await expect.poll(async () => Number(await page.getByTestId("analyzer-time").getAttribute("data-signal-peak"))).toBeGreaterThan(0.001);
  await page.keyboard.up("a");
  await mode.selectOption("epic");
  await expect(mode).toHaveValue("epic");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(mode).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("MIDI playback meters compression and WAV exports respect the selected mode", async ({ page }, testInfo) => {
  await page.goto("/");
  await waitForSf2Ready(page);
  await page.getByLabel("Import MIDI file", { exact: true }).setInputFiles({
    name: "orchestral-tutti.mid", mimeType: "audio/midi", buffer: loudChordMidi(),
  });
  await expect(page.locator(".midiMetadataTitle")).toContainText("orchestral-tutti.mid");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => Number(await page.getByLabel("Reduction", { exact: true }).getAttribute("value"))).toBeGreaterThan(0.5);
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  if (await pause.isVisible()) await pause.click();

  const peaks: Record<string, number> = {};
  const data: Buffer[] = [];
  for (const mode of ["epic", "off"]) {
    await page.getByLabel("Dynamic compression", { exact: true }).selectOption(mode);
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export WAV", exact: true }).click();
    const download = await pending;
    const path = testInfo.outputPath(`${mode}.wav`);
    await download.saveAs(path);
    const wav = readFileSync(path);
    data.push(wav);
    let peak = 0;
    for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)) / 32768);
    peaks[mode] = peak;
    await expect(page.getByRole("button", { name: "Export WAV", exact: true })).toBeEnabled();
  }
  expect(peaks.epic).toBeGreaterThan(0.1);
  expect(peaks.epic).toBeLessThanOrEqual(10 ** (-1 / 20));
  expect(peaks.off).toBeGreaterThan(peaks.epic);
  expect(data[0].length).toBe(data[1].length);
  expect(data[0].equals(data[1])).toBe(false);
});
