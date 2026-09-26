# OMR test fixtures

Every fixture is a triple: **input image (or tokens) + known notation + match rule.**
Never "it looks like music."

## Layout

```
fixtures/<id>/
  input.png              renderer output (staff crop 1280x256 grayscale, or full page)
  input.jpg              optional camera version
  expected.tokens.json   Python homr oracle token stream (Layer A reference)
  oracle.tokens.json     same bytes, kept for provenance (== expected.tokens.json)
  expected.midi          optional; NOT the canonical comparison source
  expected.notes.csv     tick,pitch,duration,staff — canonical GT from the notation source
  meta.yaml              clef,key,time,source,license,match_tier (+ threshold)
```

`expected.notes.csv` is derived from the **notation source** (the MEI/LilyPond that
was rendered), never from homr output.

## Scoring layers

- **Layer A — tokens.** Decoded symbols vs `expected.tokens.json` (Python homr).
  Exact per-stream comparison; Levenshtein distance printed every run.
  Note: the decoder emits 21 symbols on the C-scale; homr's `parse_staffs`
  appends a 22nd `"newline"` at the pipeline layer. Layer A compares raw
  decoder output (21/21), documented per fixture.
- **Layer B — MIDI.** Writer output as a sorted `(tick,pitch,duration,staff)`
  note list vs `expected.notes.csv`. Compared as note lists, never SMF bytes.
  Canonical rules: format 1, 480 TPQ, quarter = 480, dots x1.5/x1.75, C4 = 60,
  `#` +1 / `b` -1, chords share onset, rests advance the cursor,
  clefs/barlines are no-ops, staff order top-to-bottom.
- **Layer C — layout.** Soft gate: every sounding MIDI note needs a
  `noteLayout` entry, else `layoutSource` must be `"midi-fallback"`.

Diagnostics: tokens match but MIDI differs -> writer is wrong. MIDI matches
but tokens differ -> fixture export is wrong. Both edit distances are always
reported separately.

## Match tiers

- `exact_tokens` — Layer A and B exact; fails the build on any mismatch.
- `exact_midi` — Layer B exact; tokens report-only.
- `midi_distance` — fails only above `midi_distance_threshold` in meta.yaml.
- `snapshot` — artifact/report only, never fails CI.

## The CLI

```
npm run omr-test -- fixtures/<id>            # one fixture through its tier
npm run omr-test -- --tier exact_tokens --no-onnx   # writer-only, instant
npm run omr-test -- --tier exact_tokens              # full, incl. ONNX inference
npm run omr-test -- --tier midi_distance --fetch    # fetch downloadable fixtures first
```

Exit 0 = every executed fixture passed its tier. Token and MIDI edit
distances print on every run. Writer-only tests are instant; ONNX tests are
slow (marked by the ~8s inference note in output). Weights + tokenizer JSON
are pinned under `../models/` (`npm run fetch:models`).

## Current pack

| id | tier | content |
|----|------|---------|
| mono.c_major_scale | exact_tokens | C-major scale E4–E5–E4, 15 quarters, treble (real homr dewarp oracle) |
| mono.sharps_flats | exact_tokens | C D E F# G Ab B C quarters, treble |
| mono.rhythms | exact_tokens | whole/half/quarter/8th/16th/dotted-quarter/dotted-8th |
| mono.rests | exact_tokens | quarters + quarter rests, half + half rest |
| poly.chord | exact_tokens | two quarter triads + one half triad |
| clefs.bass | exact_tokens | C-major scale C3–C4, 8 quarters, bass clef |
| piano.grand | exact_midi | two staves, 8 quarters each (page-level; needs Phase 3 geometry) |

Synthetic fixtures are rendered from authored MEI via Verovio 6.3.0, so the
page and the GT come from the same source. `camera.deskew` is intentionally
absent: photographing a print is not part of the agent loop.
