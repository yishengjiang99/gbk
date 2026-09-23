import { expect, test } from "@playwright/test";

test("playback rebuilds the master bus and track nodes after the audio context closes", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.audioContexts = [];
    window.audioNodes = [];
    const Context = window.AudioContext;
    window.AudioContext = class extends Context {
      constructor(...args) { super(...args); window.audioContexts.push(this); }
    };
    const Worklet = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends Worklet {
      constructor(ctx, name, opts) { super(ctx, name, opts); window.audioNodes.push({ node: this, name }); }
    };
  ` });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Export WAV", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  const peak = () => page.getByTestId("analyzer-time").getAttribute("data-signal-peak").then(Number);
  await expect.poll(peak).toBeGreaterThan(0.002);
  await page.getByRole("button", { name: "Pause", exact: true }).click();

  const closed = await cdp.send("Runtime.evaluate", {
    expression: "window.audioContexts[window.audioContexts.length - 1].close()", awaitPromise: true,
  });
  expect(closed.exceptionDetails).toBeUndefined();
  await expect(page.locator(".statusDock")).toContainText("Audio: closed");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect(page.locator(".statusDock")).toContainText("Audio: running");
  await expect(page.getByText(/Cannot resume a closed AudioContext/)).not.toBeVisible();
  const result = await cdp.send("Runtime.evaluate", {
    expression: `JSON.stringify({
      contexts: audioContexts.map(ctx => ctx.state),
      masters: audioNodes.filter(rec => rec.name === 'master-dynamics' && rec.node.context.state === 'running').length,
      tracks: audioNodes.filter(rec => rec.name === 'sf2-processor' && rec.node.context.state === 'running').length
    })`, returnByValue: true,
  });
  expect(JSON.parse(result.result.value)).toEqual({ contexts: ["closed", "running"], masters: 1, tracks: 13 });
  // The analyzer must also have been reconnected to the replacement graph.
  await expect.poll(peak).toBeGreaterThan(0.002);
});
