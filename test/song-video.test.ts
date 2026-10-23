import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyProject } from "../src/workstation/model.ts";
import { buildVideoModel, frameCount, frameTime, activeNotes, sectionAt } from "../src/video/piano-roll-video.ts";
import { buildSongs } from "../scripts/build-songs.ts";
import { substitute, slugify } from "../scripts/song.ts";

function proj() {
  const p = emptyProject("T", 480);
  p.tempos = [{ tick: 0, microPerQuarter: Math.round(60e6 / 120) }, { tick: 4 * 480, microPerQuarter: Math.round(60e6 / 60) }];
  p.tracks = [{ id: "a", name: "A", channel: 0, color: "#ff0000", mix: { volume: 100, pan: 64, expression: 127, mute: false, solo: false }, visible: true }];
  p.notes = [{ id: "n1", trackId: "a", channel: 0, tick: 0, duration: 480, pitch: 60, velocity: 100 }, { id: "n2", trackId: "a", channel: 0, tick: 4 * 480, duration: 480, pitch: 64, velocity: 100 }];
  p.meta = { sections: [{ name: "A", startBar: 1, bars: 1 }, { name: "B", startBar: 2, bars: 1 }] };
  return p;
}

test("video model follows the tempo map; frames are i/fps and cover the audio", () => {
  const m = buildVideoModel(proj(), 4.5);
  assert.deepEqual(m.notes.map((n) => [n.t0, n.t1]), [[0, 0.5], [2, 3]]); // 4 beats @120 = 2 s, then 1 beat @60 = 1 s
  assert.deepEqual(m.sections.map((s) => [s.name, s.t]), [["A", 0], ["B", 2]]);
  for (const fps of [30, 60]) {
    const n = frameCount(4.5, fps); assert.equal(n, 4.5 * fps);
    assert.ok(frameTime(n - 1, fps) < 4.5 && frameTime(n, fps) >= 4.5);
    // The note sounding at 2.000 s is lit exactly on frame 2*fps (onset inclusive), not one frame late or early.
    assert.deepEqual(activeNotes(m, frameTime(2 * fps, fps)).map((x) => x.pitch), [64]);
    assert.deepEqual(activeNotes(m, frameTime(2 * fps - 1, fps)).map((x) => x.pitch), []);
  }
  assert.equal(frameCount(74.111, 30), 2224);
  assert.equal(sectionAt(m, 1.99)?.name, "A"); assert.equal(sectionAt(m, 2)?.name, "B");
});

test("recipe placeholders and slugs", () => {
  assert.deepEqual(substitute({ ids: ["$track[1]"], p: "$proposal", k: "x" }, { tracks: ["t0", "t1"], proposal: "pr" }), { ids: ["t1"], p: "pr", k: "x" });
  assert.equal(slugify("Midnight Invention No. 2!"), "midnight-invention-no-2");
});

test("gallery: newest first, per-song pages with downloads, workstation link, escaped text", () => {
  const src = mkdtempSync(join(tmpdir(), "songs-")), out = mkdtempSync(join(tmpdir(), "gal-"));
  const f = (n: string) => ({ name: n, bytes: 10, sha256: "ab" });
  for (const [dir, title] of [["2026-01-01-old", "Old <b>song</b>"], ["2026-10-23-new", "New song"]]) {
    mkdirSync(join(src, dir)); for (const x of ["video.mp4", "poster.png", "song.mid", "song.mp3", "project.json"]) writeFileSync(join(src, dir, x), "x");
    writeFileSync(join(src, dir, "song.json"), JSON.stringify({ title, slug: dir, date: dir.slice(0, 10), composer: "c", durationSeconds: 61, files: { wav: { ...f("song.wav"), url: "https://example/song.wav" }, mid: f("song.mid"), mp3: f("song.mp3"), mp4: f("video.mp4"), poster: f("poster.png") } }));
  }
  mkdirSync(join(src, "recipes"));
  assert.deepEqual(buildSongs(src, out, "/gbk/"), ["2026-10-23-new", "2026-01-01-old"]);
  const idx = readFileSync(join(out, "index.html"), "utf8");
  assert.ok(idx.indexOf("2026-10-23-new") < idx.indexOf("2026-01-01-old"));
  assert.match(idx, /Old &lt;b&gt;song&lt;\/b&gt;/);
  const page = readFileSync(join(out, "2026-10-23-new", "index.html"), "utf8");
  for (const s of ['src="video.mp4"', 'href="song.mid"', 'href="https://example/song.wav"', 'href="/gbk/?song=2026-10-23-new"']) assert.ok(page.includes(s), s);
  assert.ok(existsSync(join(out, "2026-10-23-new", "video.mp4")));
});
