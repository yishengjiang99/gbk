// Independent browser contexts (separate cookies/guests), real WebRTC data channels on localhost (direct, no TURN),
// notes checked through the receiving session's scheduler counters AND audio energy on that player's engine.
import { test, expect, type Browser, type Page } from "@playwright/test";

type Jam = { router: { noteOn(n: number, v: number, t: number): void; noteOff(n: number, t: number): void }; received: Map<string, number>; selfId: string; links: Map<string, string>; peerStats(pid: string): { link: { relay: boolean | null; eventsOrdered: boolean | null; eventsMaxRetransmits: number | null } | null; receive: unknown } };
declare global { interface Window { __gbkJam?: Jam; __gbkJamAudio?: { level(pid: string): number } } }

const GUEST: Record<string, string> = { P1: "AmberFox", P2: "BlueOwl", P3: "CalmBear", P4: "DeepElk", P5: "EagerCat" };
/** guest = go through the "Continue as guest" UI (guest creation is limited to 5 per IP per hour, so only one player does). */
async function player(browser: Browser, name: string, url: string, guest = false): Promise<Page> {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${name}] pageerror`, e.message));
  if (!guest) {
    const csrf = (await (await ctx.request.get("/api/session")).json()).csrf as string;
    const r = await ctx.request.post("/api/login", { headers: { origin: "http://127.0.0.1:5211", "x-gbk-csrf": csrf }, data: { code: `jam-${name.slice(1)}` } });
    expect(r.status()).toBe(200);
  }
  await page.goto(url);
  if (guest) { await page.getByTestId("jam-guest-name").fill(GUEST[name]); await page.getByTestId("jam-guest").click(); }
  return page;
}
const selfId = (p: Page) => p.evaluate(() => window.__gbkJam!.selfId);

async function room(browser: Browser, n: number, guestHost = false) {
  const host = await player(browser, "P1", "/jam", guestHost);
  await host.getByTestId("jam-create").click();
  await host.getByTestId("jam-enter").click();
  await expect(host.getByTestId("jam-room")).toBeVisible();
  const link = await host.getByTestId("jam-invite-link").inputValue();
  const code = await host.getByTestId("jam-invite-code").textContent();
  expect(link).toContain("#i="); expect(code).toMatch(/^[A-Z0-9]{8}$/);
  const pages = [host];
  for (let i = 2; i <= n; i++) {
    const p = await player(browser, `P${i}`, link.replace(/^https?:\/\/[^/]+/, ""));
    await p.getByTestId("jam-enter").click(); await expect(p.getByTestId("jam-room")).toBeVisible(); pages.push(p);
  }
  // every player sees n-1 peer strips and every link open
  for (const p of pages) {
    await expect(p.getByTestId("jam-strip-peer")).toHaveCount(n - 1);
    await expect.poll(() => p.evaluate(() => [...window.__gbkJam!.links.values()].filter((s) => s === "ready").length), { timeout: 30_000 }).toBe(n - 1);
  }
  return pages;
}

async function playAndCheck(pages: Page[], from: number, note: number) {
  const src = await selfId(pages[from]);
  const before = await Promise.all(pages.map((p) => p.evaluate((id) => window.__gbkJam!.received.get(id) ?? 0, src)));
  await pages[from].evaluate((n) => window.__gbkJam!.router.noteOn(n, 110, performance.now()), note);
  const peaks = await Promise.all(pages.map(async (p, i) => i === from ? 0 : p.evaluate(async (id) => { let m = 0; for (let k = 0; k < 40; k++) { m = Math.max(m, window.__gbkJamAudio!.level(id)); await new Promise((r) => setTimeout(r, 25)); } return m; }, src)));
  await pages[from].evaluate((n) => window.__gbkJam!.router.noteOff(n, performance.now()), note);
  for (let i = 0; i < pages.length; i++) {
    if (i === from) continue;
    await expect.poll(() => pages[i].evaluate((id) => window.__gbkJam!.received.get(id) ?? 0, src)).toBe(before[i] + 1);
    expect(peaks[i], `P${i + 1} hears P${from + 1}`).toBeGreaterThan(0.001);
  }
}

test("two players: notes arrive over real data channels and sound on the receiver", async ({ browser }) => {
  const pages = await room(browser, 2, true);
  await playAndCheck(pages, 0, 60);
  await playAndCheck(pages, 1, 64);
  await pages[0].waitForTimeout(2500);
  const s = await pages[0].evaluate(() => { const j = window.__gbkJam!; const pid = [...j.links.keys()][0]; return j.peerStats(pid); });
  expect(s.link?.eventsOrdered).toBe(false); expect(s.link?.eventsMaxRetransmits).toBe(0);
  console.log("P1 view of P2:", JSON.stringify(s));
});

test("four players, mixed instruments: everyone hears everyone", async ({ browser }) => {
  const pages = await room(browser, 4);
  const choices = ["0:0", "0:24", "0:48", "128:0"];
  for (let i = 0; i < 4; i++) await pages[i].getByTestId("jam-instrument").selectOption(choices[i]);
  await pages[0].waitForTimeout(500);
  for (let i = 0; i < 4; i++) await playAndCheck(pages, i, 60 + i);
  // a fifth player is refused
  const link = await pages[0].getByTestId("jam-invite-link").inputValue();
  const p5 = await player(browser, "P5", link.replace(/^https?:\/\/[^/]+/, ""));
  await p5.getByTestId("jam-enter").click();
  await expect(p5.getByRole("alert")).toContainText("full");
});
