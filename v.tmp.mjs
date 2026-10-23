import { chromium, devices } from "@playwright/test";
const b = await chromium.launch({ args: ["--host-resolver-rules=MAP compose.grepawk.com 64.23.239.208"] });
const ctx = await b.newContext({ ...devices["Pixel 7"], viewport: { width: 390, height: 844 } }); const p = await ctx.newPage();
await p.goto("https://compose.grepawk.com/"); await p.waitForSelector("[data-testid=top-card]"); await p.waitForTimeout(1000);
console.log(await p.evaluate(() => ["html","body","#root",".xp"].map(s => { const e = document.querySelector(s); const c = getComputedStyle(e); return `${s} h=${e.getBoundingClientRect().height|0} sh=${e.scrollHeight} ov=${c.overflowY} cls=${e.className}`; }).join("\n") + `\ninner=${innerHeight} se.sh=${document.scrollingElement.scrollHeight}`));
await b.close();
