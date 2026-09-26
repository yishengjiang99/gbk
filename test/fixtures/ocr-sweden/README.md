# OCR Sweden fixture

## Contents

- `sweden-carlo-prato.mid` — user-uploaded MIDI, copied verbatim from
  `C418_-_Sweden__Minecraft_Main_Theme_a__midi_by_Carlo_Prato___www.cprato.com.mid`
  (1507 bytes, valid MThd header). Arrangement: **"Sweden (Minecraft Main
  Theme)" by Carlo Prato, www.cprato.com**. Third-party arrangement; see
  caveats below.
- The sheet image this is scored against is the repo-root `sweden.jpg`
  (3024x4032 iPhone photo of a printed piano arrangement of "Sweden",
  D major, 4/4, ♩= 46, 16 bars over 4 grand-staff systems).

## What this fixture is for

`test/e2e/ocr-sweden-ground-truth.spec.ts` runs the production
`parseSheetMusicToMidi()` on `sweden.jpg` in a real browser and scores the
generated MIDI note-by-note against this MIDI (matched / missed / extra,
precision, recall, F1 via LCS on time-ordered pitch sequences, plus the
median onset offset of LCS-aligned pairs). Run with:

```
npm run test:e2e:ocr-fixture
```

## Important caveat: the pair does NOT match by construction

Unlike `test/fixtures/ocr-ground-truth/` (PNG + MIDI generated from one
LilyPond source), this is a **differential gauge, not an accuracy bar**.
The photo shows a *different* piano arrangement than the one Carlo Prato
engraved for his MIDI. All accuracy assertions in the spec are
report-only — do not tighten them or adjust the reader to chase this
number.

## Measured baseline (2026-09-25, improved reader)

- Truth notes: 95 (7 tracks, all notes on track 2; polyphonic block chords
  + melody, pitch range G2–F♯5)
- Generated notes: 238 (8 staff groups detected — correct for 4 systems —
  360 notehead candidates)
- Matched (LCS): 42 · missed: 53 · extra: 196
- Precision 0.176 · Recall 0.442 · F1 **0.252**
- Median onset offset (generated − truth): +20.3 s

## Systematic differences found

1. **Different voicing.** The Prato MIDI uses block chords (e.g. opening
   B2/E3/G3 = Em, later A-major-family voicings) plus a melody line. The
   photographed sheet uses *rolled (arpeggiated) chord clusters* in the
   treble — stacked noteheads played as arpeggios — with a separate bass
   line. The OCR detects each notehead of those clusters individually, so
   the generated sequence contains repeating 4-note stacked patterns
   (e.g. 43/53/57/64/67/74/77) that have no counterpart in the MIDI's
   block-chord voicings. This is the main source of the 196 "extra" notes.
2. **Different length and tempo.** The MIDI spans ~41 s; the photographed
   sheet is 16 bars at ♩= 46. The OCR assigns timing under its own
   quarter-note-timing assumption, so the two timelines run on different
   clocks (hence the +20 s median onset offset — not a fixed shift, but a
   scale mismatch). LCS-on-pitch scoring is insensitive to this, but any
   future timing-aware scoring must normalize tempo first.
3. **Shared pitch vocabulary, different melody realization.** Both are in
   D major and draw from the same pitch range (truth 43–78, generated
   43–84), which is why 42 pitches still LCS-match (recall 0.44) despite
   the arrangement mismatch. The truth's top line (e.g. 69/71/71/66/47/
   62/64/66…) is a different realization of the melody than the photo's
   treble line, and the photo's rolled chords add octave doublings the
   MIDI doesn't have.
4. **OCR reading artifacts on the clusters.** The repeated stacked
   patterns in the generated pitch sequence are suspiciously regular —
   rolled-chord noteheads bleed into each other and the reader likely
   mis-assigns some to adjacent staff lines/octaves. This is a real
   recognizer weakness on this notation style, independent of the
   arrangement mismatch, and a good target for future improvement work.
