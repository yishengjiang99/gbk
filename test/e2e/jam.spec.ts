// Independent browser contexts (separate cookies/guests), real WebRTC data channels on localhost (direct; relay-only
// through a local coturn with JAM_E2E_RELAY=1, see jam.config.ts),
// notes checked through the receiving session's scheduler counters AND audio energy on that player's engine.
import { test, expect, type Browser, type Page } from "@playwright/test";

type Jam = { snapshot?: { roomId: string } | null; router: { noteOn(n: number, v: number, t: number): void; noteOff(n: number, t: number): void }; received: Map<string, number>; selfId: string; links: Map<string, string>; metronome: { lastBeat: { beat: number; roomMs: number } | null; scheduled: number }; clock: { roomToLocal(ms: number): number; uncertaintyMs: number }; take: { count: number };
  takeProject(): { tracks: { name: string }[]; notes: { trackId: string; pitch: number; tick: number }[] }; peerStats(pid: string): { link: { relay: boolean | null; candidateType?: string | null; eventsOrdered: boolean | null; eventsMaxRetransmits: number | null } | null; receive: unknown } };
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

/** guestJoiner: P2 opens the invite link signed out, does only the guest step, and lands in the room (no lobby click). */
async function room(browser: Browser, n: number, guestJoiner = false) {
  const host = await player(browser, "P1", "/jam");
  await host.getByTestId("jam-create").click();
  await expect(host.getByTestId("jam-room")).toBeVisible();
  const link = await host.getByTestId("jam-invite-link").inputValue();
  const code = await host.getByTestId("jam-invite-code").textContent();
  expect(link).toContain("#i="); expect(code).toMatch(/^[A-Z0-9]{8}$/);
  const pages = [host];
  for (let i = 2; i <= n; i++) {
    const p = await player(browser, `P${i}`, link.replace(/^https?:\/\/[^/]+/, ""), guestJoiner && i === 2);
    await expect(p.getByTestId("jam-room")).toBeVisible(); pages.push(p);
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
  if (process.env.JAM_E2E_RELAY === "1") { expect(s.link?.relay).toBe(true); expect(s.link?.candidateType).toBe("relay"); }
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
  await expect(p5.getByRole("alert")).toContainText("full");
});

test("shared metronome: host starts it, every client clicks at the same wall time; take records editable tracks", async ({ browser }) => {
  const pages = await room(browser, 3);
  const [host, m1, m2] = pages;
  await expect(m1.getByTestId("jam-metro-toggle")).toHaveCount(0); // host-only controls
  await host.getByTestId("jam-metro-bpm").fill("150");
  await host.getByTestId("jam-metro-toggle").click();
  for (const p of pages) await expect(p.getByTestId("jam-metronome")).toHaveAttribute("data-running", "1");
  await host.waitForTimeout(2500);
  // Each client maps its last scheduled beat to absolute wall time (timeOrigin + local perf ms) for comparison.
  const wall = (p: Page) => p.evaluate(() => { const j = window.__gbkJam!; const b = j.metronome.lastBeat!; return { beat: b.beat, wall: performance.timeOrigin + j.clock.roomToLocal(b.roomMs), unc: j.clock.uncertaintyMs }; });
  const beats = await Promise.all(pages.map(wall));
  const ref = beats[0]; const beatMs = 60000 / 150;
  for (const b of beats) { const w = b.wall + (ref.beat - b.beat) * beatMs; expect(Math.abs(w - ref.wall), `click skew (±${b.unc.toFixed(1)}ms clock)`).toBeLessThan(20); }
  console.log("metronome wall-time skew ms:", beats.map((b) => (b.wall + (ref.beat - b.beat) * beatMs - ref.wall).toFixed(2)).join(", "));
  const clickLevel = await m2.evaluate(async () => { let m = 0; for (let k = 0; k < 40; k++) { m = Math.max(m, window.__gbkJamAudio!.level("__click")); await new Promise((r) => setTimeout(r, 25)); } return m; });
  expect(clickLevel).toBeGreaterThan(0.001);
  // Take on the host while a member plays; the result is one editable track per player who played.
  await host.getByTestId("jam-take-start").click();
  for (const [n, p] of [[60, m1], [64, m2], [67, m1]] as const) { await p.evaluate((x) => window.__gbkJam!.router.noteOn(x, 100, performance.now()), n); await p.waitForTimeout(200); await p.evaluate((x) => window.__gbkJam!.router.noteOff(x, performance.now()), n); }
  await expect.poll(() => host.evaluate(() => window.__gbkJam!.take.count)).toBe(3);
  await host.getByTestId("jam-take-stop").click();
  const proj = await host.evaluate(() => window.__gbkJam!.takeProject());
  expect(proj.tracks.length).toBe(2); expect(proj.notes.map((n) => n.pitch).sort()).toEqual([60, 64, 67]);
  const dl = host.waitForEvent("download"); await host.getByTestId("jam-take-mid").click(); expect((await dl).suggestedFilename()).toBe("live-jam-take.mid");
  // Stop: clicks end everywhere, playing still works without it.
  await host.getByTestId("jam-metro-toggle").click();
  for (const p of pages) await expect(p.getByTestId("jam-metronome")).toHaveAttribute("data-running", "0");
  await playAndCheck(pages, 1, 72);
});

test("code link and random open room go straight in; private rooms aren't matched", async ({ browser }) => {
  const host = await player(browser, "P5", "/jam"); // P1 already hosts rooms from earlier tests (3-room limit)
  await host.getByTestId("jam-create").click(); await expect(host.getByTestId("jam-room")).toBeVisible();
  const code = (await host.getByTestId("jam-invite-code").textContent())!;
  // /jam?code=XXXX joins without touching the lobby
  const byCode = await player(browser, "P2", `/jam?code=${code}`);
  await expect(byCode.getByTestId("jam-room")).toBeVisible(); await expect(host.getByTestId("jam-strip-peer")).toHaveCount(1);
  // Private by default: random finds nothing and offers an open room
  const r1 = await player(browser, "P3", "/jam");
  await r1.getByTestId("jam-random").click(); await expect(r1.getByTestId("jam-no-open")).toBeVisible();
  // Host opens it; random now joins it
  await host.getByTestId("jam-open").click(); await expect(host.getByTestId("jam-open")).toBeChecked();
  await r1.getByTestId("jam-random").click(); await expect(r1.getByTestId("jam-room")).toBeVisible();
  await expect(host.getByTestId("jam-strip-peer")).toHaveCount(2);
  expect(await r1.evaluate(() => window.__gbkJam!.snapshot?.roomId)).toBe(await host.evaluate(() => window.__gbkJam!.snapshot?.roomId));
  // "Create an open room" path from the empty state
  await host.getByTestId("jam-open").click(); await expect(host.getByTestId("jam-open")).not.toBeChecked();
  const r2 = await player(browser, "P4", "/jam");
  await r2.getByTestId("jam-random").click(); await r2.getByTestId("jam-create-open").click();
  await expect(r2.getByTestId("jam-room")).toBeVisible(); await expect(r2.getByTestId("jam-open")).toBeChecked();
  for (const p of [host, r2]) { p.on("dialog", (d) => d.accept()); await p.getByRole("button", { name: "End room" }).click(); }
});
