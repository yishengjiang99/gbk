// Phone studio chat follows the newest message while pinned to the bottom, and never yanks a reader who scrolled up.
// WebKit iPhone 13 with a mocked Composer server (HTTP + agent WebSocket), so it runs without the real backend.
import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";

const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `History message ${i + 1}. `.repeat(4) }));

async function open(page: Page) {
  let ws!: WebSocketRoute;
  await page.route(/\/api\//, (r) => {
    const u = new URL(r.request().url());
    if (u.pathname.endsWith("/api/session")) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: true, user: "tester", name: "Tester", csrf: "c", enabled: true }) });
    return r.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.routeWebSocket(/\/api\/agent\/ws/, (route) => {
    ws = route;
    route.onMessage((raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "hello") route.send(JSON.stringify({ type: "session_ready", sessionId: "s1", user: "tester", model: "m", models: ["m"], provider: "p", llmConfigured: true, manifestHash: "h", acceptedTools: [], rejectedTools: [], history, limits: {} }));
      if (m.type === "user_message") route.send(JSON.stringify({ type: "run_started", runId: "r1", clientMessageId: m.clientMessageId, text: m.text }));
    });
  });
  await page.goto("studio");
  await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("studio-chat")).toContainText("History message 30", { timeout: 15_000 });
  return () => ws;
}
const gap = (page: Page) => page.getByTestId("studio-chat").evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
const top = (page: Page) => page.getByTestId("studio-chat").evaluate((el) => el.scrollTop);
const step = (ws: WebSocketRoute, i: number) => ws.send(JSON.stringify({ type: "tool_intent", runId: "r1", callId: `c${i}`, tool: "gbk_add_notes", arguments: {}, task: `Streamed step number ${i}` }));

test("chat sticks to the newest message: open, send, streamed steps, keyboard; scrolled-up reader stays put", async ({ page }) => {
  const ws = await open(page);
  // Open: lands at the newest message.
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
  expect(await page.getByTestId("composer-input").evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(16);

  // Send: the user's message is visible at the bottom.
  await page.getByTestId("composer-input").fill("Make it jazzier please");
  await page.getByTestId("composer-input").press("Enter");
  await expect(page.getByTestId("studio-chat")).toContainText("Make it jazzier please");
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);

  // Streamed steps and text while pinned: keeps following.
  for (let i = 1; i <= 6; i++) { step(ws(), i); ws().send(JSON.stringify({ type: "assistant_delta", runId: "r1", text: `More streamed words ${i}. `.repeat(3) })); await page.waitForTimeout(60); }
  await expect(page.getByTestId("studio-chat")).toContainText("Streamed step number 6");
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
  await expect(page.getByText("Streamed step number 6")).toBeInViewport();

  // Keyboard opens (visual viewport/--vvh shrinks): still at the newest message, composer visible.
  await page.getByTestId("composer-input").focus();
  const vp = page.viewportSize()!;
  await page.setViewportSize({ width: vp.width, height: vp.height - 300 });
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
  await expect(page.getByTestId("composer-input")).toBeInViewport();
  await page.setViewportSize(vp);
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);

  // Scrolled up on purpose: new content does not pull the reader down; a "Jump to latest" pill appears.
  await page.getByTestId("studio-chat").evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
  await page.waitForTimeout(100);
  for (let i = 7; i <= 9; i++) step(ws(), i);
  await expect(page.getByTestId("studio-chat")).toContainText("Streamed step number 9");
  await expect(page.getByTestId("jump-latest")).toBeVisible();
  await page.waitForTimeout(200);
  expect(await top(page)).toBeLessThanOrEqual(2);
  // Keyboard while scrolled up: still stays put.
  await page.setViewportSize({ width: vp.width, height: vp.height - 300 }); await page.waitForTimeout(150);
  expect(await top(page)).toBeLessThanOrEqual(2);
  await page.setViewportSize(vp);

  // The pill jumps back and re-pins.
  await page.getByTestId("jump-latest").click();
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
  await expect(page.getByTestId("jump-latest")).toHaveCount(0);

  // Sending always re-pins, even after scrolling up.
  ws().send(JSON.stringify({ type: "run_completed", runId: "r1", text: "Done.", artifacts: [], steps: 9 }));
  await page.getByTestId("studio-chat").evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
  await page.getByTestId("composer-input").fill("One more change");
  await page.getByTestId("composer-input").press("Enter");
  await expect(page.getByTestId("studio-chat")).toContainText("One more change");
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
