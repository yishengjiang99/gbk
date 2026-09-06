import { expect, test } from "@playwright/test";

for (const kind of ["blank", "corrupt"] as const) {
  test(`${kind} sheet preserves the loaded MIDI and emits no generated song`, async ({ page }) => {
    await page.goto("/");
    const metadata = page.getByLabel("MIDI metadata");
    await expect(metadata).toBeVisible();
    const before = await metadata.textContent();
    const saved = await page.evaluate(() => localStorage.getItem("sf2-current-midi"));
    await page.evaluate(() => {
      document.documentElement.dataset.generatedScans = "0";
      window.addEventListener("sheetmusicreader:generated-midi", () => {
        document.documentElement.dataset.generatedScans = "1";
      });
    });
    const bytes = kind === "corrupt" ? [0, 1, 2, 3] : await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 600;
      canvas.height = 800;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, 600, 800);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((value) => resolve(value!), "image/png"));
      return [...new Uint8Array(await blob.arrayBuffer())];
    });
    await page.getByLabel("Scan or upload sheet music").setInputFiles({
      name: `${kind}.png`, mimeType: "image/png", buffer: Buffer.from(bytes),
    });
    const convert = page.getByRole("button", { name: "Convert previewed sheet music to MIDI" });
    await convert.click();
    await expect(page.getByText(kind === "blank" ? /No five-line staff was detected/ : /Image decoding failed/).first()).toBeVisible();
    await expect(convert).toBeEnabled();
    await expect(metadata).toHaveText(before!);
    expect(await page.evaluate(() => localStorage.getItem("sf2-current-midi"))).toBe(saved);
    await expect(page.locator("html")).toHaveAttribute("data-generated-scans", "0");
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  });
}
