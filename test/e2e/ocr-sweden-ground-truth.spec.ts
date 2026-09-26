import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

import { parseMidiBuffer } from "../../src/midi-timer.worker.ts";

/**
 * Sweden OCR scoring against a user-supplied MIDI.
 *
 * Sheet image : repo-root sweden.jpg (iPhone photo of a printed piano
 *               arrangement of "Sweden" from Minecraft, D major, 4/4).
 * Ground truth: test/fixtures/ocr-sweden/sweden-carlo-prato.mid — the
 *               "Sweden (Minecraft Main Theme)" piano arrangement by
 *               Carlo Prato (www.cprato.com), uploaded by the user.
 *
 * Unlike the c-scale fixture (image and MIDI generated from one LilyPond
 * source, matching by construction), this pairing is NOT exact: the photo
 * shows a different piano arrangement than the one Carlo Prato engraved
 * for his MIDI. Expect systematic differences (different voicing, rolled
 * chords in the photo vs. the MIDI's chord voicings, different octave
 * doublings, 16 printed bars vs. the MIDI's shorter structure).
 *
 * This spec is therefore a differential gauge, not a pass/fail accuracy
 * test: all accuracy assertions are report-only. Do not tighten them to
 * chase this number — report it honestly and investigate systematic
 * differences (see README.md) instead.
 *
 * How it runs: same approach as ocr-ground-truth.spec.ts — the repo's
 * src/sheet-music-reader.ts is transpiled and run as a module on an
 * about:blank page (real browser: createImageBitmap + canvas, exactly like
 * the app), parseSheetMusicToMidi() is called on sweden.jpg, and the
 * generated MIDI is scored note-level against the fixture MIDI: matched /
 * missed / extra notes plus precision, recall, F1 (LCS on the
 * time-ordered pitch sequences), plus the median onset offset of the
 * LCS-aligned note pairs.
 *
 * Run together with the c-scale loop: npm run test:e2e:ocr-fixture
 */

const SPEC_DIR = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(SPEC_DIR, "..", "..");
const FIXTURE_DIR = path.join(REPO_ROOT, "test", "fixtures", "ocr-sweden");

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

interface LcsResult {
  matched: number;
  /** onset offsets (generated - truth) in seconds for the aligned pairs */
  onsetOffsets: number[];
}

/**
 * Longest-common-subsequence on pitch sequences with traceback, so we can
 * also measure how well the aligned pairs agree in time.
 */
function lcsPitchAlignment(truth: ScoredNote[], generated: ScoredNote[]): LcsResult {
  const n = truth.length;
  const m = generated.length;
  const dp: Uint16Array[] = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Uint16Array(m + 1));
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      dp[i][j] =
        truth[i - 1].pitch === generated[j - 1].pitch
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const onsetOffsets: number[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (truth[i - 1].pitch === generated[j - 1].pitch && dp[i][j] === dp[i - 1][j - 1] + 1) {
      onsetOffsets.push(generated[j - 1].startSec - truth[i - 1].startSec);
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return { matched: dp[n][m], onsetOffsets };
}

function parseSongFromBytes(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return parseMidiBuffer(copy.buffer);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

test("OCR Sweden: photo scan scores against Carlo Prato arrangement MIDI", async ({ page }) => {
  const swedenJpg = path.join(REPO_ROOT, "sweden.jpg");
  const fixtureMid = path.join(FIXTURE_DIR, "sweden-carlo-prato.mid");
  expect(fs.existsSync(swedenJpg), `Sweden sheet photo missing: ${swedenJpg}`).toBe(true);
  expect(fs.existsSync(fixtureMid), `fixture MIDI missing: ${fixtureMid}`).toBe(true);

  const truthBytes = fs.readFileSync(fixtureMid);
  const truthSong = parseSongFromBytes(Uint8Array.from(truthBytes));
  const truthNotes = toScoredNotes(truthSong);
  expect(truthNotes.length).toBeGreaterThan(0);

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

  const jpgBase64 = fs.readFileSync(swedenJpg).toString("base64");
  const generated = await page.evaluate(
    async ({ b64 }: { b64: string }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes.buffer as ArrayBuffer], "sweden.jpg", { type: "image/jpeg" });
      const mod = (window as unknown as { __ocr: { parseSheetMusicToMidi: (f: File) => Promise<{ fileName: string; midiData: ArrayBuffer; warnings: string[] }> } }).__ocr;
      const out = await mod.parseSheetMusicToMidi(file);
      return {
        fileName: out.fileName,
        warnings: out.warnings,
        midiBytes: Array.from(new Uint8Array(out.midiData)),
      };
    },
    { b64: jpgBase64 }
  );

  const generatedBytes = Uint8Array.from(generated.midiBytes);
  expect(generatedBytes.length).toBeGreaterThan(4);
  expect(Buffer.from(generatedBytes.slice(0, 4)).toString("ascii")).toBe("MThd");

  const generatedSong = parseSongFromBytes(generatedBytes);
  const generatedNotes = toScoredNotes(generatedSong);

  const { matched, onsetOffsets } = lcsPitchAlignment(truthNotes, generatedNotes);
  const missed = truthNotes.length - matched;
  const extra = generatedNotes.length - matched;
  const precision = generatedNotes.length ? matched / generatedNotes.length : 0;
  const recall = truthNotes.length ? matched / truthNotes.length : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const medianOnsetOffset = median(onsetOffsets);

  const truthPitches = truthNotes.map((n) => n.pitch).join(" ");
  const generatedPitches = generatedNotes.map((n) => n.pitch).join(" ");

  const report = [
    "",
    "=== OCR Sweden report: sweden.jpg vs Carlo Prato MIDI ===",
    `truth notes     : ${truthNotes.length}   [${truthPitches}]`,
    `generated notes : ${generatedNotes.length}   [${generatedPitches}]`,
    `matched (LCS)   : ${matched}`,
    `missed          : ${missed}`,
    `extra           : ${extra}`,
    `precision       : ${precision.toFixed(3)}`,
    `recall          : ${recall.toFixed(3)}`,
    `F1              : ${f1.toFixed(3)}`,
    `median onset offset (generated - truth): ${medianOnsetOffset.toFixed(3)}s`,
    `ocr warnings    : ${generated.warnings.join(" ")}`,
    "NOTE: arrangement mismatch expected — see test/fixtures/ocr-sweden/README.md",
    "==========================================================",
    "",
  ].join("\n");
  // eslint-disable-next-line no-console
  console.log(report);
  test.info().annotations.push({
    type: "ocr-sweden",
    description: `matched=${matched} missed=${missed} extra=${extra} precision=${precision.toFixed(3)} recall=${recall.toFixed(3)} f1=${f1.toFixed(3)}`,
  });

  // Report-only assertions: the fixture MIDI is a third-party arrangement
  // that does not match the photographed sheet note-for-note, so this
  // number is a differential gauge, not an accuracy bar. Keep green while
  // the recognizer improves; never force a pass by adjusting these.
  expect(matched).toBeGreaterThanOrEqual(0);
});
