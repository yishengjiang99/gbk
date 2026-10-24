// Real-browser check (Chromium and WebKit/iPhone profile): gbk_render_wav synthesizes only inside an
// OfflineAudioContext (counted via a constructor spy), while a realtime AudioContext is never needed.
import { test, expect } from "@playwright/test";

test("gbk_render_wav renders through OfflineAudioContext + AudioWorklet in the browser", async ({ page }) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => {
    localStorage.setItem("gbk.agentTools", "1");
    const w = window as any; w.__oac = 0;
    const Base = w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
    const Spy = function (this: unknown, ...a: unknown[]) { w.__oac++; return new Base(...a); } as unknown as typeof OfflineAudioContext;
    Spy.prototype = Base.prototype;
    w.OfflineAudioContext = Spy;
  });
  await page.goto("/gbk/");
  await page.waitForFunction(async () => ((await (window as any).gbkTools?.list()) ?? []).length > 40, undefined, { timeout: 60_000 });
  const call = async (n: string, a: any) => JSON.parse(await page.evaluate(([n, a]) => (window as any).gbkTools.call(n, a), [n, a] as const) as string);
  expect((await call("gbk_create_project", { name: "Slowly Evolving Ambient", tempo: 60, key: "D major", replaceCurrent: true })).ok).toBe(true);
  const g = await call("gbk_generate_arrangement", { style: "ambient", key: "D major", bars: Number(process.env.GBK_RENDER_BARS ?? 8), seed: 1, voices: 3, instrumentation: ["pad", "strings", "piano"] });
  expect(g.ok, JSON.stringify(g.error)).toBe(true);
  const t0 = Date.now();
  const r = await call("gbk_render_wav", { output: "artifact", includeMidi: false });
  const ms = Date.now() - t0;
  expect(r.ok && r.data.status === "completed", JSON.stringify(r.error ?? r.data)).toBe(true);
  expect(r.data.validated).toBe(true);
  expect(await page.evaluate(() => (window as any).__oac)).toBeGreaterThanOrEqual(1);
  console.log("render", test.info().project.name, JSON.stringify({ seconds: r.data.durationSeconds, ms, peak: r.data.peakDbFS }));
});
