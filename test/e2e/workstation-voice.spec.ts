import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const SHOTS = process.env.GBK_SHOTS ?? "/workspace/shots";
type R = { ok: boolean; revision: number; data: any; warnings: string[]; error?: { code: string; message: string } };
async function tool(page: Page, name: string, args: object = {}): Promise<R> {
  const out = await page.evaluate(async ([n, a]) => {
    const mc = (document as any).modelContext;
    const t = (await mc.getTools()).find((x: any) => x.name === n);
    if (!t) throw new Error(`tool ${n} not registered`);
    return await mc.executeTool(t, a);
  }, [name, args] as const);
  return JSON.parse(out as string);
}
async function startTool(page: Page, name: string, args: object) {
  await page.evaluate(([n, a]) => {
    const mc = (document as any).modelContext;
    (window as any).__pending = mc.getTools().then((ts: any[]) => mc.executeTool(ts.find((x) => x.name === n), a));
  }, [name, args] as const);
  return async () => JSON.parse(await page.evaluate(() => (window as any).__pending)) as R;
}
/** 16-bit PCM WAV -> per-window RMS (dBFS) of the mixed channels. */
function wavStats(path: string) {
  const b = readFileSync(path); let off = 12, data = 0, len = 0, ch = 2, sr = 44100;
  while (off < b.length - 8) { const id = b.toString("ascii", off, off + 4), n = b.readUInt32LE(off + 4); if (id === "fmt ") { ch = b.readUInt16LE(off + 10); sr = b.readUInt32LE(off + 12); } if (id === "data") { data = off + 8; len = n; break; } off += 8 + n; }
  const frames = Math.floor(len / (2 * ch)); const s = new Float32Array(frames);
  for (let i = 0; i < frames; i++) { let v = 0; for (let c = 0; c < ch; c++) v += b.readInt16LE(data + 2 * (i * ch + c)) / 32768; s[i] = v / ch; }
  return { s, sr };
}
const energy = (s: Float32Array, a: number, z: number) => { let e = 0; for (let i = Math.max(0, a); i < Math.min(s.length, z); i++) e += s[i] * s[i]; return e; };

async function exportWav(page: Page, path: string) {
  const [dl, r] = await Promise.all([page.waitForEvent("download", { timeout: 280_000 }), tool(page, "gbk_prepare_wav_export", {})]);
  expect(r.ok, JSON.stringify(r.error)).toBe(true);
  await dl.saveAs(path); return wavStats(path);
}

test("agent sound design: longer release + more reverb, A/B, accept, audible difference", async ({ page }) => {
  test.setTimeout(900_000);
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.goto("/gbk/");
  await page.getByTestId("open-player").click();
  await page.getByText(/habanera/i).first().click();
  await page.getByTestId("close-player").click();
  await expect(page.locator(".ws-name")).toContainText(/habanera/i, { timeout: 20_000 });
  await page.getByTestId("agent-toggle").check();
  await expect(page.getByTestId("webmcp-status")).toHaveText(/WebMCP on/);
  const names: string[] = await page.evaluate(async () => (await (document as any).modelContext.getTools()).map((t: any) => t.name));
  expect(names).toEqual(expect.arrayContaining(["gbk_get_voice_settings", "gbk_propose_voice_patch", "gbk_set_effects"]));
  const caps = await tool(page, "gbk_get_capabilities");
  expect(caps.data.controllers["91"].audible).toBe(true);
  expect(caps.data.effects.reverb).toBeTruthy();

  const tracks = (await tool(page, "gbk_list_tracks")).data as any[];
  const target = tracks.filter((t) => t.notes > 0).sort((a, b) => b.notes - a.notes)[0];
  await page.getByTestId(`track-${target.name}`).getByRole("button").first().click();

  // Baseline render (also makes sure the SoundFont + player hold the project).
  const A = await exportWav(page, `${SHOTS}/gbk-voice-A.wav`);
  const vs = await tool(page, "gbk_get_voice_settings", { trackId: target.id, key: 60 });
  expect(vs.ok).toBe(true);
  console.log("preset", vs.data.preset, "zones", vs.data.zones.length, "release s", vs.data.zones[0]?.generators.volEnvRelease.value, "reverb", JSON.stringify(vs.data.zones[0]?.effectiveSends.reverb));
  expect(vs.data.zones.length).toBeGreaterThan(0);
  const rel0 = vs.data.zones[0].generators.volEnvRelease.value as number;
  await page.screenshot({ path: `${SHOTS}/gbk-voice-01-panel.png` });

  // Agent proposes a longer release + more reverb send on the track, and a bigger room.
  const bad = await tool(page, "gbk_propose_voice_patch", { trackId: target.id, edits: [{ param: "volEnvRelease", mode: "set", value: 1000 }] });
  expect(bad.ok).toBe(false); expect(bad.error!.code).toBe("INVALID_ARGUMENT");
  const pr = await tool(page, "gbk_propose_voice_patch", { trackId: target.id, summary: "longer release, wetter", edits: [{ param: "volEnvRelease", mode: "set", value: Math.max(2.5, rel0 * 3) }, { param: "reverbSend", mode: "set", value: 80 }] });
  expect(pr.ok, JSON.stringify(pr.error)).toBe(true);
  await expect(page.getByTestId("sound-diff")).toContainText("volEnvRelease");
  await expect(page.getByTestId("adsr-graph-b")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/gbk-voice-02-proposal-diff.png` });
  const a = await tool(page, "gbk_preview_proposal", { proposalId: pr.data.proposalId, variant: "A" });
  const b = await tool(page, "gbk_preview_proposal", { proposalId: pr.data.proposalId, variant: "B" });
  console.log("preview A", a.ok, a.error?.code, "B", b.ok, b.error?.code);
  expect(a.ok && b.ok).toBe(true);
  const done = await startTool(page, "gbk_commit_proposal", { proposalId: pr.data.proposalId });
  await page.getByTestId(`proposal-${pr.data.proposalId}`).getByRole("button", { name: "Accept" }).click();
  expect((await done()).ok).toBe(true);

  const fx = await tool(page, "gbk_set_effects", { roomSize: 0.9, reverbLevel: 0.8, summary: "bigger hall" });
  expect(fx.ok).toBe(true);
  const done2 = await startTool(page, "gbk_commit_proposal", { proposalId: fx.data.proposalId });
  await page.getByTestId(`proposal-${fx.data.proposalId}`).getByRole("button", { name: "Accept" }).click();
  expect((await done2()).ok).toBe(true);
  const vs2 = await tool(page, "gbk_get_voice_settings", { trackId: target.id, key: 60 });
  expect(vs2.data.zones[0].generators.volEnvRelease.overridden).toBe(true);
  expect(vs2.data.zones[0].effectiveSends.reverb.effectivePercent).toBeGreaterThanOrEqual(80);
  await page.screenshot({ path: `${SHOTS}/gbk-voice-03-accepted.png` });

  // Verify the audio difference on the same offline render path as WAV export.
  const B = await exportWav(page, `${SHOTS}/gbk-voice-B.wav`);
  const n = Math.min(A.s.length, B.s.length);
  let diff = 0; for (let i = 0; i < n; i++) diff += (A.s[i] - B.s[i]) ** 2;
  const eA = energy(A.s, 0, n), eB = energy(B.s, 0, n);
  const tailA = energy(A.s, A.s.length - 2 * A.sr, A.s.length), tailB = energy(B.s, B.s.length - 2 * B.sr, B.s.length);
  console.log(JSON.stringify({ lenA: A.s.length, lenB: B.s.length, eA, eB, diffRatio: diff / eA, tailA, tailB }));
  expect(diff / eA).toBeGreaterThan(0.01);
  expect(eB).toBeGreaterThan(eA * 1.05);   // wetter + longer release => more energy overall
  expect(tailB).toBeGreaterThan(tailA);     // reverb/release tail past the dry end

  // Undo restores the dry sound settings (same history as the user).
  await tool(page, "gbk_undo"); await tool(page, "gbk_undo");
  const vs3 = await tool(page, "gbk_get_voice_settings", { trackId: target.id, key: 60 });
  expect(vs3.data.zones[0].generators.volEnvRelease.overridden).toBe(false);
  await tool(page, "gbk_redo"); await tool(page, "gbk_redo");
  // Reload: sound settings persist with the project.
  const revFinal = (await tool(page, "gbk_get_project_summary")).revision;
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(page.getByTestId("webmcp-status")).toHaveText(/WebMCP on/);
  await expect.poll(async () => (await tool(page, "gbk_get_project_summary")).revision, { timeout: 20_000 }).toBe(revFinal);
  const after = await tool(page, "gbk_get_voice_settings", { trackId: target.id });
  expect(after.data.overrides.length).toBe(2);
  expect(after.data.effects.roomSize).toBe(0.9);
  await page.screenshot({ path: `${SHOTS}/gbk-voice-04-after-reload.png` });
});
