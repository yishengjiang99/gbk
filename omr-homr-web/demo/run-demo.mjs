/* Playwright driver for the isolated browser demo. Opens the demo page in a
 * real Chromium, waits for the Worker transcription to finish, and prints the
 * result JSON. Exit 0 only when the demo reports pass. */
import { chromium } from "playwright";

const port = Number(process.env.DEMO_PORT ?? 8901);
const executablePath = process.env.CHROME_PATH; // else Playwright's bundled Chromium

const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: [
    "--enable-unsafe-webgpu",
    "--use-angle=swiftshader",
    "--enable-features=Vulkan",
    "--disable-features=LocalNetworkAccessChecks",
    "--no-sandbox",
  ],
});

const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.error("[page error]", m.text().slice(0, 300));
});
page.on("pageerror", (e) => console.error("[pageerror]", String(e).slice(0, 300)));

await page.goto(`http://127.0.0.1:${port}/demo/`, { waitUntil: "load" });
await page.waitForFunction("window.__demoResult !== undefined", null, { timeout: 420000 });
const result = await page.evaluate("window.__demoResult");
console.log(JSON.stringify(result, null, 2));
await browser.close();
process.exit(result.pass ? 0 : 1);
