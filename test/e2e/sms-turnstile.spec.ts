// #222: Cloudflare Turnstile must load under the app's cross-origin isolation (COOP same-origin + COEP credentialless)
// so SMS sign-in works. Real Turnstile (Cloudflare's always-pass test sitekey) inside the real sign-in sheet; only
// /api/session's sms flag, the site key and the SMS send are stubbed, so no Twilio/Turnstile secrets are needed.
import { test, expect } from "@playwright/test";

const TEST_SITEKEY = "1x00000000000000000000AA"; // Cloudflare test key: always passes, any hostname
const TEST_TOKEN = "XXXX.DUMMY.TOKEN.XXXX"; // what that key issues

test("Turnstile loads under COEP and its token reaches the SMS send", async ({ page, browserName }) => {
  await page.route("**/api/session", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), sms: true } });
  });
  await page.route("**/api/auth/sms/config", (route) => route.fulfill({ json: { enabled: true, turnstileSiteKey: TEST_SITEKEY, countries: ["+1"] } }));
  let sent: { phone?: string; turnstileToken?: string } | null = null;
  await page.route("**/api/auth/sms/start", async (route) => { sent = route.request().postDataJSON(); await route.fulfill({ json: { ok: true } }); });

  const doc = await page.goto("/studio");
  const headers = doc!.headers();
  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(headers["cross-origin-embedder-policy"]).toBe("credentialless");
  // Chromium honours credentialless, so the page really is isolated; WebKit ignores it (single-threaded Scan).
  if (browserName === "chromium") expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("gbk:need-signin", { detail: { why: "Sign in", pending: null } })));
  await expect(page.getByTestId("signin-sheet")).toBeVisible();
  await page.getByTestId("signin-phone").fill("+15555550123");
  const send = page.getByTestId("signin-sms-send");
  await expect(send).toBeDisabled(); // no captcha token yet
  // The challenge iframe is Cloudflare's own document; COEP would block it here if it failed to load.
  await expect.poll(() => page.frames().some((f) => f.url().startsWith("https://challenges.cloudflare.com/")), { timeout: 30_000 }).toBe(true);
  await expect(send).toBeEnabled({ timeout: 30_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); // widget fits the sheet
  await send.click();
  await expect(page.getByTestId("signin-otp")).toBeVisible();
  expect(sent).toEqual({ phone: "+15555550123", turnstileToken: TEST_TOKEN });
});
