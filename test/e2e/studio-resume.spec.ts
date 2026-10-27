// iOS WKWebView: a composer run survives the page being hidden and its socket dropping (app tab switch), re-attaching
// by run id when visible again; a fresh page load ends the in-flight run cleanly; flushSave writes IndexedDB now.
import { test, expect, type Page } from "@playwright/test";
import { composerConn } from "./app-menu";
const MODEL = "http://127.0.0.1:8799";
const openGate = () => fetch(`${MODEL}/gate`, { method: "POST" });

async function signIn(page: Page) {
  await expect(page.getByTestId("workstation")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("gbk:need-signin", { detail: { why: "Sign in", pending: null } })));
  await page.getByTestId("signin-code").fill("e2e-code-4"); await page.getByTestId("signin-code-submit").click();
  await expect(page.getByTestId("signin-sheet")).toBeHidden({ timeout: 15_000 });
  await expect(composerConn(page)).toHaveAttribute("data-state", "connected", { timeout: 30_000 });
  const modal = page.getByTestId("paywall-modal");
  try { await expect(modal).toBeVisible({ timeout: 4000 }); await page.getByTestId("paywall-later").click(); } catch { /* no paywall */ }
}
async function send(page: Page, text: string) {
  await expect(async () => { await page.getByTestId("composer-input").fill(text); await expect(page.getByTestId("composer-send")).toBeVisible({ timeout: 1000 }); }).toPass({ timeout: 15_000 });
  await page.getByTestId("composer-send").click();
}
/** Simulate the WKWebView going to the background: page hidden, live socket dropped, reconnects fail until visible. */
const hide = (page: Page) => page.evaluate(() => {
  const w = window as any;
  if (!w.__realWS) { w.__realWS = WebSocket; w.WebSocket = class extends w.__realWS { constructor(u: string, p?: string) { super(w.__blockWS ? "ws://127.0.0.1:9/" : u, p); } }; }
  w.__blockWS = true; w.__hidden = true;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (w.__hidden ? "hidden" : "visible") });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => !!w.__hidden });
  document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("pagehide"));
  w.__gbkComposer.client.ws?.close();
});
const show = (page: Page) => page.evaluate(() => { const w = window as any; w.__blockWS = false; w.__hidden = false; document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("pageshow")); });

test("iphone resume: hidden + dropped socket mid-run, then visible: the run re-attaches and completes; a reload ends a run cleanly", async ({ page }) => {
  test.skip(test.info().project.name !== "mobile-webkit", "WebKit iPhone");
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/studio"); await signIn(page);
  await send(page, "resume check one");
  await expect(page.getByTestId("composer-stop")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500); // first tool step done; the model's next reply is held at the gate
  await hide(page);
  await expect.poll(() => page.evaluate(() => (window as any).__gbkComposer.client.connected)).toBe(false);
  await openGate(); // the next tool call is issued while the tab is away: the server must hold it, not fail it
  await page.waitForTimeout(3000);
  await show(page);
  await expect(page.getByText(/Resumed OK after 1 summary read/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("studio-error")).toHaveCount(0);
  await expect(page.getByTestId("composer-stop")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeVisible();

  // Tab truly gone: a new page (iOS Create -> /studio?new=<n>) cannot re-attach; the old run ends with a short message.
  await send(page, "resume check two");
  await expect(page.getByTestId("composer-stop")).toBeVisible({ timeout: 30_000 }); await page.waitForTimeout(1500);
  await page.goto(`/studio?new=${Date.now()}`);
  await expect(composerConn(page)).toHaveAttribute("data-state", "connected", { timeout: 30_000 });
  await openGate();
  await expect(page.getByTestId("studio-error").last()).toContainText(/reloaded or closed/, { timeout: 30_000 });
  await expect(page.getByTestId("composer-stop")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await page.evaluate(() => (window as any).__gbkComposer.client.send({ type: "reset_conversation" })); // clean test data
});

test("iphone resume: gbkStudio.flushSave() writes the project to IndexedDB before the autosave debounce; pagehide flushes too", async ({ page }) => {
  test.skip(test.info().project.name !== "mobile-webkit", "WebKit iPhone");
  const stored = (n: string) => page.evaluate((name) => new Promise<boolean>((ok) => { const r = indexedDB.open("gbk-midi"); r.onsuccess = () => { const q = r.result.transaction("projects").objectStore("projects").getAll(); q.onsuccess = () => ok(q.result.some((x: any) => x.project?.name === name)); }; }), n);
  const seed = (n: string) => page.evaluate(async (name) => { const c = (globalThis as any).__gbkWorkstation;
    await c.createProject({ name, owner: "user", replaceCurrent: true });
    c.edit([{ op: "addTrack", name: "Melody", channel: 0, id: "t_m", program: 0 }, { op: "addNotes", notes: [{ trackId: "t_m", channel: 0, tick: 0, duration: 480, pitch: 64, velocity: 90 }] }], { label: "seed" }); }, n);
  await page.goto("/studio"); await page.waitForFunction(() => !!(window as any).gbkStudio?.flushSave);
  const A = `Flush A ${Date.now()}`; await seed(A);
  expect(await page.evaluate(() => typeof (window as any).gbkStudio.flushSave().then)).toBe("function");
  await page.evaluate(() => (window as any).gbkStudio.flushSave());
  expect(await stored(A)).toBe(true);
  const B = `Flush B ${Date.now()}`; await seed(B);
  expect(await page.evaluate(() => { window.dispatchEvent(new Event("pagehide")); return new Promise((r) => setTimeout(r, 300)); }).then(() => stored(B))).toBe(true); // well inside the 800 ms debounce
  await page.evaluate((names) => new Promise<void>((ok) => { const r = indexedDB.open("gbk-midi"); r.onsuccess = () => { const s = r.result.transaction("projects", "readwrite").objectStore("projects"); const q = s.getAll(); q.onsuccess = () => { for (const x of q.result) if (names.includes(x.project?.name)) s.delete(x.id); ok(); }; }; }), [A, B]); // clean test data
});
