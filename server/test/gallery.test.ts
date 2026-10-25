// Demo gallery (#72 Phase 4): explanations are computed from data, the SMF CC11 reader is exact, and the
// preview page + downloads are admin-only (404 for everyone else), noindex, and path-safe.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptModel, reply } from "./helpers.ts";
import { startServer } from "./ws-helpers.ts";
import { explain, pianoRollSvg, type GComposition, type GNote, type GalleryManifest } from "../src/gallery.ts";
import { smfCc11 } from "../../scripts/gallery/build.ts";
import { RECIPES } from "../../scripts/gallery/recipes.ts";

const comp: GComposition = { title: "T <x>", key: "F major", seed: 1, ppq: 480, tempoBpm: 120, timeSignature: [4, 4], bars: 3, durationSec: 4, noteCount: 6, ccCount: 2,
  sections: [{ name: "A", startBar: 1, bars: 1 }, { name: "B", startBar: 2, bars: 1 }],
  tracks: [{ id: "m", name: "Melody", role: "melody", program: 0, channel: 0, notes: 2, controllers: [11] }, { id: "b", name: "Bass", role: "bass", program: 32, channel: 1, notes: 4, controllers: [] }], revision: 2 };
const notes: GNote[] = [
  { trackId: "m", tick: 0, duration: 240, pitch: 72, velocity: 90 }, { trackId: "m", tick: 240, duration: 240, pitch: 77, velocity: 90 },
  ...[0, 1, 2, 3].map((i) => ({ trackId: "b", tick: 1920 + i * 480, duration: 480, pitch: 41 + i, velocity: 80 })),
];

test("explain() states only facts from the data", () => {
  const e = explain(comp, notes, [{ trackId: "m", tick: 0, value: 60 }, { trackId: "m", tick: 1920, value: 110 }]);
  assert.match(e[0]!, /^2 bars of 4\/4 at 120 BPM in F major/, "bar count comes from the last note, not the padded length");
  assert.ok(e.some((s) => s === "Sections: A (bars 1–1), B (bars 2–2)."));
  assert.ok(e.some((s) => s.startsWith("Melody (melody): 2 notes from C5 to F5, first entry in bar 1.")));
  assert.ok(e.some((s) => s.includes("Bass (bass): 4 notes from F2 to Ab2, first entry in bar 2, 100% of them quarter notes")));
  assert.ok(e.some((s) => s.includes("enter one after another (Melody, Bass)")));
  assert.ok(e.some((s) => s.includes("from 60 to 110 (a crescendo)")));
  assert.ok(!e.join(" ").match(/walking|fugue|subject|loop/i), "no musical claims the data can't support");
});

test("pianoRollSvg() is a static SVG with one rect per note and an escaped label", () => {
  const svg = pianoRollSvg(comp, notes);
  assert.equal((svg.match(/<rect /g) ?? []).length, notes.length);
  assert.ok(!svg.includes("<script") && !svg.includes("<x>"));
});

test("smfCc11() reads CC11 events (with running status) per channel", () => {
  const trk = Buffer.from([0x00, 0xb1, 11, 40, 0x60, 11, 90, 0x00, 0xb1, 7, 100, 0x00, 0xff, 0x2f, 0x00]);
  const smf = Buffer.concat([Buffer.from("MThd"), Buffer.from([0, 0, 0, 6, 0, 1, 0, 1, 1, 0xe0]), Buffer.from("MTrk"), Buffer.from([0, 0, 0, trk.length]), trk]);
  assert.deepEqual(smfCc11(smf), [{ channel: 1, tick: 0, value: 40 }, { channel: 1, tick: 96, value: 90 }]);
});

test("six recipes cover the Phase 4 demo set with fixed seeds", () => {
  assert.deepEqual(RECIPES.map((r) => r.slug), ["baroque-fugue", "two-part-invention", "orchestral-cue", "game-soundtrack", "ambient-piano", "jazz-walking-bass"]);
  for (const r of RECIPES) assert.equal(typeof r.create.seed, "number", r.slug);
  assert.equal(RECIPES.filter((r) => r.featured).length, 3);
});

test("/chatgpt/gallery is public and indexable; files are path-safe; sitemap + /chatgpt featured demos link to it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gbk-gallery-"));
  const demo = { slug: "baroque-fugue", title: "Demo One", prompt: "p", featured: true, recipe: { create: { seed: 1 }, edits: [] }, composition: comp, notes, cc11: [],
    wav: { file: "song.wav", sizeBytes: 4, sha256: "a", sampleRate: 44100, channels: 2, bits: 16, seconds: 1 }, midi: { file: "song.mid", sizeBytes: 4, sha256: "b", format: 1, tracks: 2, division: 480 },
    explanation: ["fact one"], reproducibility: { builtAt: "t", server: "s", serverCommit: "c", soundFont: "sf", renderer: "server", revision: 2 } };
  mkdirSync(join(dir, "gallery", "baroque-fugue"), { recursive: true });
  writeFileSync(join(dir, "gallery", "manifest.json"), JSON.stringify({ generatedAt: "t", demos: [demo] } satisfies GalleryManifest));
  writeFileSync(join(dir, "gallery", "baroque-fugue", "song.wav"), "RIFF"); writeFileSync(join(dir, "gallery", "baroque-fugue", "song.mid"), "MThd");
  writeFileSync(join(dir, "gallery", "baroque-fugue", "secret.txt"), "nope");
  const s = await startServer(new ScriptModel([() => reply("unused")]), { COMPOSER_DATA_DIR: dir });
  try {
    const page = await fetch(`${s.base}/chatgpt/gallery`); const html = await page.text();
    assert.equal(page.status, 200, "public, logged out");
    assert.ok(html.includes('content="index,follow"') && html.includes('rel="canonical" href="http://composer.test/chatgpt/gallery"') && html.includes("Demo One") && html.includes("fact one"));
    assert.ok(html.includes("All four voices enter together in bar 1"), "fugue states plainly that voices enter together");
    assert.ok(!/staggered subject\/answer entries\)|enter one after another/.test(html));
    assert.ok(!html.includes("<script") && !html.includes("Private preview"));
    const wav = await fetch(`${s.base}/chatgpt/gallery/baroque-fugue/song.wav`);
    assert.equal(wav.status, 200); assert.equal(wav.headers.get("content-type"), "audio/wav"); assert.equal(await wav.text(), "RIFF");
    assert.match((await fetch(`${s.base}/chatgpt/gallery/baroque-fugue/song.mid`)).headers.get("content-disposition") ?? "", /attachment; filename="baroque-fugue.mid"/);
    for (const p of ["/chatgpt/gallery/baroque-fugue/secret.txt", "/chatgpt/gallery/..%2Fgallery/song.wav", "/chatgpt/gallery/nope/song.wav", "/chatgpt/gallery/baroque-fugue/manifest.json"])
      assert.equal((await fetch(s.base + p)).status, 404, p);
    assert.ok((await (await fetch(`${s.base}/sitemap.xml`)).text()).includes("<loc>http://composer.test/chatgpt/gallery</loc>"));
    const landing = await (await fetch(`${s.base}/chatgpt`)).text();
    assert.ok(landing.includes('id="listen"') && landing.includes('src="/chatgpt/gallery/baroque-fugue/song.wav"') && landing.includes('href="/chatgpt/gallery"'));
  } finally { await s.app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("/chatgpt omits the featured section when no gallery is built", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gbk-gallery-empty-"));
  const s = await startServer(new ScriptModel([() => reply("unused")]), { COMPOSER_DATA_DIR: dir });
  try { assert.ok(!(await (await fetch(`${s.base}/chatgpt`)).text()).includes('id="listen"')); assert.equal((await fetch(`${s.base}/chatgpt/gallery`)).status, 200); }
  finally { await s.app.close(); rmSync(dir, { recursive: true, force: true }); }
});
