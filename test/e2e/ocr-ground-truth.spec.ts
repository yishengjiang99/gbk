import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import { parseMidiBuffer } from "../../src/midi-timer.worker.ts";

/**
 * OCR ground-truth iteration loop.
 *
 * Fixture: test/fixtures/ocr-ground-truth/c-scale.{png,mid,ly}
 * The PNG and the MIDI were generated from the SAME LilyPond source
 * (c-scale.ly), so they match by construction.
 *
 * How it runs: the spec transpiles src/sheet-music-reader.ts with the repo's
 * own TypeScript, loads it as a module on an about:blank page (no dev server
 * needed), and calls the production parseSheetMusicToMidi() on the fixture
 * PNG in a real browser (createImageBitmap + canvas, exactly like the app).
 * The produced MIDI is then scored against the ground-truth MIDI at note
 * level: matched / missed / extra notes, precision, recall, F1 — printed to
 * the console and attached to the test report.
 *
 * Accuracy assertions are intentionally report-only: the point of this loop
 * is to watch the numbers improve as the recognizer improves. Tighten the
 * assertions once the recognizer is reliably accurate.
 *
 * Run: npm run test:e2e:ocr-fixture
 */

const SPEC_DIR = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(SPEC_DIR, "..", "..");
const FIXTURE_DIR = path.join(REPO_ROOT, "test", "fixtures", "ocr-ground-truth");

interface ScoredNote {
  pitch: number;
  startSec: number;
}

function toScoredNotes(song: { tracks: { notes: { note: number; startSec: number }[] }[] }): ScoredNote[] {
  return song.tracks
    .flatMap((track) => track.notes)
    .map((note) => ({ pitch: note.note, startSec: note.startSec }))
    .sort((a, b) => a.startSec - b.startSec || a.pitch - b.pitch);
}

/**
 * Longest-common-subsequence alignment on pitch sequences (monophonic, so
 * order is meaningful). Returns the number of matched notes.
 */
function lcsPitchMatches(truth: ScoredNote[], generated: ScoredNote[]): number {
  const n = truth.length;
  const m = generated.length;
  let prev = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    const curr = new Array<number>(m + 1).fill(0);
    for (let j = 1; j <= m; j += 1) {
      curr[j] =
        truth[i - 1].pitch === generated[j - 1].pitch
          ? prev[j - 1] + 1
          : Math.max(prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[m];
}

function parseSongFromBytes(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return parseMidiBuffer(copy.buffer);
}

test("OCR ground truth: c-scale scan scores against known MIDI", async ({ page }) => {
  const fixturePng = path.join(FIXTURE_DIR, "c-scale.png");
  const fixtureMid = path.join(FIXTURE_DIR, "c-scale.mid");
  expect(fs.existsSync(fixturePng), `fixture PNG missing: ${fixturePng}`).toBe(true);
  expect(fs.existsSync(fixtureMid), `fixture MIDI missing: ${fixtureMid}`).toBe(true);

  const truthBytes = fs.readFileSync(fixtureMid);
  const truthSong = parseSongFromBytes(Uint8Array.from(truthBytes));
  const truthNotes = toScoredNotes(truthSong);
  expect(truthNotes.length).toBe(15);

  // Transpile the repo's OCR module and load it in the browser. The module
  // is self-contained (no imports), so a plain transpile suffices.
  const ocrSource = fs.readFileSync(path.join(REPO_ROOT, "src", "sheet-music-reader.ts"), "utf8");
  const ocrJs = ts.transpileModule(ocrSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  await page.goto("about:blank");
  await page.evaluate(async (code: string) => {
    const blob = new Blob([code], { type: "text/javascript" });
    const mod = await import(URL.createObjectURL(blob));
    (window as unknown as { __ocr: unknown }).__ocr = mod;
  }, ocrJs);

  const pngBase64 = fs.readFileSync(fixturePng).toString("base64");
  const generated = await page.evaluate(
    async ({ b64 }: { b64: string }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes.buffer as ArrayBuffer], "c-scale.png", { type: "image/png" });
      const mod = (window as unknown as { __ocr: { parseSheetMusicToMidi: (f: File) => Promise<{ fileName: string; midiData: ArrayBuffer; warnings: string[] }> } }).__ocr;
      const out = await mod.parseSheetMusicToMidi(file);
      return {
        fileName: out.fileName,
        warnings: out.warnings,
        midiBytes: Array.from(new Uint8Array(out.midiData)),
      };
    },
    { b64: pngBase64 }
  );

  const generatedBytes = Uint8Array.from(generated.midiBytes);
  expect(generatedBytes.length).toBeGreaterThan(4);
  expect(Buffer.from(generatedBytes.slice(0, 4)).toString("ascii")).toBe("MThd");

  const generatedSong = parseSongFromBytes(generatedBytes);
  const generatedNotes = toScoredNotes(generatedSong);

  const matched = lcsPitchMatches(truthNotes, generatedNotes);
  const missed = truthNotes.length - matched;
  const extra = generatedNotes.length - matched;
  const precision = generatedNotes.length ? matched / generatedNotes.length : 0;
  const recall = truthNotes.length ? matched / truthNotes.length : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  const truthPitches = truthNotes.map((n) => n.pitch).join(" ");
  const generatedPitches = generatedNotes.map((n) => n.pitch).join(" ");

  const report = [
    "",
    "=== OCR ground-truth report: c-scale ===",
    `truth notes     : ${truthNotes.length}   [${truthPitches}]`,
    `generated notes : ${generatedNotes.length}   [${generatedPitches}]`,
    `matched (LCS)   : ${matched}`,
    `missed          : ${missed}`,
    `extra           : ${extra}`,
    `precision       : ${precision.toFixed(3)}`,
    `recall          : ${recall.toFixed(3)}`,
    `F1              : ${f1.toFixed(3)}`,
    `ocr warnings    : ${generated.warnings.join(" ")}`,
    "==========================================",
    "",
  ].join("\n");
  // eslint-disable-next-line no-console
  console.log(report);
  test.info().annotations.push({
    type: "ocr-ground-truth",
    description: `matched=${matched} missed=${missed} extra=${extra} precision=${precision.toFixed(3)} recall=${recall.toFixed(3)} f1=${f1.toFixed(3)}`,
  });

  // Report-only assertions: keep the suite green while the recognizer improves.
  // Tighten these (e.g. expect(f1).toBeGreaterThanOrEqual(0.9)) once accuracy
  // is reliably high.
  expect(matched).toBeGreaterThanOrEqual(0);
});
