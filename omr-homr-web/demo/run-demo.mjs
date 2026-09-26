/* Playwright driver for the isolated browser demo. Opens the demo page in a
 * real Chromium, waits for the Worker transcription to finish, and prints the
 * result JSON. Exit 0 only when the demo reports pass. */
import { chromium } from "playwright";
import { existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const port = Number(process.env.DEMO_PORT ?? 8901);
const demoPath = process.env.DEMO_PAGE ?? "/demo/";
const executablePath = process.env.CHROME_PATH; // else Playwright's bundled Chromium

// SwiftShader's bundled vk_swiftshader_icd.json uses a relative
// "./libvk_swiftshader.so" path, so vkCreateInstance fails unless the CWD
// happens to be the chrome dir. Point Vulkan at an absolute-path ICD instead.
if (!process.env.VK_ICD_FILENAMES) {
  const candidates = [];
  if (executablePath) candidates.push(join(dirname(executablePath), "libvk_swiftshader.so"));
  const cache = join(process.env.HOME ?? tmpdir(), ".cache", "ms-playwright");
  try {
    const { readdirSync } = await import("node:fs");
    for (const d of readdirSync(cache)) {
      if (d.startsWith("chromium-")) candidates.push(join(cache, d, "chrome-linux", "libvk_swiftshader.so"));
    }
  } catch { /* no playwright cache */ }
  const found = candidates.find((p) => existsSync(p));
  if (found) {
    const icd = join(mkdtempSync(join(tmpdir(), "vk-icd-")), "swiftshader.json");
    writeFileSync(icd, JSON.stringify({ file_format_version: "1.0.0", ICD: { library_path: found, api_version: "1.0.5" } }));
    process.env.VK_ICD_FILENAMES = icd;
    console.log(`using SwiftShader ICD: ${icd}`);
  }
}

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

await page.goto(`http://127.0.0.1:${port}${demoPath}`, { waitUntil: "load" });
await page.waitForFunction("window.__demoResult !== undefined", null, { timeout: 420000 });
const result = await page.evaluate("window.__demoResult");
console.log(JSON.stringify(result, null, 2));
await browser.close();
process.exit(result.pass ? 0 : 1);
