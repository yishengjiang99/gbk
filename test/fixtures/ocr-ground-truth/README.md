# OCR ground-truth fixture: C major scale (E4–E5, ascending and descending)

## What this is

A sheet-music image (`c-scale.png`) and its accompanying MIDI file
(`c-scale.mid`) that are **known to match**, used as the ground-truth
artifact for the sheet-music OCR iteration loop
(`npm run test:e2e:ocr-fixture`, spec at `test/e2e/ocr-ground-truth.spec.ts`).

## How the match is guaranteed

Both artifacts are generated from the **single source** `c-scale.ly`
with one LilyPond command:

```sh
lilypond --png -dresolution=200 -o c-scale c-scale.ly
```

That command emits `c-scale.png` (the engraved score) and
`c-scale.midi` (the performance) from the same note data, so the pair
matches by construction — no hand alignment, no guessing.

## The piece

- Melody: C major scale, ascending and descending, E4 to E5
- Staff: single treble staff
- Key: C major (no key signature, no accidentals — the recognizer assumes
  C major)
- Time: 4/4
- Rhythm: quarter notes only (the current recognizer assumes quarter-note
  timing)
- Range E4..E5: every note sits strictly inside the treble staff, no
  ledger lines
- Stemless noteheads (`\omit Stem`): the recognizer's notehead filter
  rejects tall head+stem components, so the fixture uses stemless quarters
- Noteheads shrunk two steps (`NoteHead.font-size = #-2`): the
  recognizer's notehead size window (area <= 0.95 * spacing^2) is tuned
  for smaller heads than LilyPond's default

Why a scale rather than a tune: the recognizer's staff-line peak detection
merges line peaks when many noteheads cluster in adjacent staff positions
(their ink bridges the projection peaks, biasing line centers and
breaking staff-line suppression). A scale spreads noteheads evenly across
all staff positions — each line/space is used once or twice — which is
what the current conservative recognizer can handle. A clustered melody
(e.g. "Mary Had a Little Lamb" transposed) currently breaks staff
detection entirely and would make a good *stretch* fixture once the
recognizer improves.

Exact note sequence (15 notes, scientific pitch notation, MIDI numbers):

| #   | Pitch | MIDI |
|-----|-------|------|
| 1   | E4    | 64   |
| 2   | F4    | 65   |
| 3   | G4    | 67   |
| 4   | A4    | 69   |
| 5   | B4    | 71   |
| 6   | C5    | 72   |
| 7   | D5    | 74   |
| 8   | E5    | 76   |
| 9   | D5    | 74   |
| 10  | C5    | 72   |
| 11  | B4    | 71   |
| 12  | A4    | 69   |
| 13  | G4    | 67   |
| 14  | F4    | 65   |
| 15  | E4    | 64   |

Pitch sequence:
`64 65 67 69 71 72 74 76 74 72 71 69 67 65 64`

## Engraving settings

- LilyPond 2.24.3, A4 portrait, 200 DPI PNG, cropped to the content bounding
  box plus a 200 px margin (final image 1096x456). The wide margin is
  deliberate: a tight crop trips the recognizer's staff-spacing clamp
  (`maxStaffSpacing = min(26, image.height / 20)`), which expects
  photo-like framing with background around the staff.
- Treble clef and common-time symbol printed (the recognizer does not read
  them; they are present for realism and must not break detection)
- Single system; the MIDI is rendered at 100 BPM (quarter = 100)

## Regenerating

```sh
cd test/fixtures/ocr-ground-truth
lilypond --png -dresolution=200 -o c-scale c-scale.ly
mv c-scale.midi c-scale.mid   # LilyPond emits .midi; the repo uses .mid
# then crop c-scale.png to the content bounding box + 200 px margin
```

Then verify the MIDI still encodes the 15 pitches above
(see the iteration-loop spec, which parses both MIDIs and scores them).

## Baseline (2026-09-25)

Current recognizer scores 15/15 on this fixture (precision = recall =
F1 = 1.000). It serves as a regression guard: if OCR changes break it,
the loop catches it. Harder fixtures (clustered melodies, ledger lines,
stems, photos) can be added alongside it to drive further improvements.
