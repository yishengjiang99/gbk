// SMS sign-in is gone: the sheet must not offer a phone option, even if /api/session still claims sms: true
// (covers a stale flag or an old client expectation). WebKit iPhone + Chrome.
import { test, expect } from "@playwright/test";

test("sign-in sheet shows no phone option", async ({ page }) => {
  await page.route("**/api/session", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), sms: true } });
  });
  await page.goto("/studio");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("gbk:need-signin", { detail: { why: "Sign in", pending: null } })));
  const sheet = page.getByTestId("signin-sheet");
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("signin-phone")).toHaveCount(0);
  await expect(page.getByTestId("signin-sms-send")).toHaveCount(0);
  await expect(page.getByTestId("signin-turnstile")).toHaveCount(0);
  await expect(page.getByTestId("signin-otp")).toHaveCount(0);
  await expect(sheet.getByLabel("Phone number")).toHaveCount(0);
  await expect(sheet.getByText(/text me a code/i)).toHaveCount(0);
  await expect(sheet.getByPlaceholder("+1 555 123 4567")).toHaveCount(0);
});
