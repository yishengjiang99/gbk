# Sheet Music Parser Integration Plan

## Current Status

The app has a sheet-music image workflow in the MIDI toolbar. It accepts JPG and PNG files, displays the selected image in a preview panel, and converts the displayed image into MIDI only after the user presses `Convert MIDI`. The generated MIDI is routed into the existing MIDI playback path through `loadMidiIntoTracks(...)`.

The toolbar also includes a `Sweden` button. It loads the bundled `sweden.jpg` baseline image into the same preview panel so the sample sheet can be displayed and converted without selecting a local file.

The parser now runs a first-pass browser image pipeline before falling back to the dependency-free Sweden transcription demo from `~/sheet_music_reader`.

Implemented parser stages:

- Decode uploaded image files with browser image APIs.
- Scale large images before pixel inspection.
- Threshold the image with Otsu-style luminance analysis.
- Detect likely five-line staff groups from horizontal dark-pixel density.
- Detect simple notehead-like connected components after suppressing staff-line pixels.
- Map detected noteheads to treble-clef pitches.
- Encode detected notes as a format-1 MIDI file.
- Fall back to the Sweden transcription demo when image decoding, staff detection, or note detection fails.

Recent scanning changes:

- `Upload Sheet` now selects and displays a JPG/PNG instead of immediately converting it.
- The displayed sheet image is represented by `selectedSheetMusicImage` in `src/midireader.tsx`.
- Preview URLs are created with `URL.createObjectURL(...)` and revoked when the selected preview changes or unmounts.
- `Convert MIDI` calls `parseSheetMusicToMidi(...)` for the currently displayed image.
- The `Sweden` button fetches the bundled `sweden.jpg`, wraps it in a `File`, displays it, and lets the normal convert flow process it.
- E2E tests assert both paths: bundled Sweden display/convert and general JPG upload/display/convert.
- Detected grand-staff pages now pair adjacent staves into shared systems so right-hand and left-hand notes align in time instead of playing as separate sequential lines.
- Detected note timing is mapped from horizontal position across each visual system, with each system spanning four bars. This prevents held notes, rests, and sparse notation from collapsing the scan into only the first few bars.
- Generated detected-sheet MIDI uses 46 BPM and writes a harmless end marker at the next four-bar boundary so trailing rests contribute to MIDI duration without adding fake audible notes.

This is still a conservative first-pass recognizer. It assumes treble clef and quarter-note timing for detected notes. It does not yet detect clefs, key signatures, accidentals, rests, stems, beams, dots, ties, multiple voices, or piano grand-staff relationships.

Implemented files:

- `src/sheet-music-reader.ts`
- `src/midireader.tsx`
- `src/styles.css`
- `test/sheet-music-reader.test.ts`
- `test/e2e/sheet-music-scan.spec.ts`

Verified with:

- `npm run typecheck`
- `npm test`
- `npx playwright test test/e2e/sheet-music-scan.spec.ts --reporter=line`
- `npm run build`

The current Sweden baseline test uses `sweden.jpg` as the displayed source image and compares the generated MIDI against `sweden.midi` with tolerance-based checks for note recovery and pitch-class overlap. This avoids requiring byte-for-byte parity with the richer baseline MIDI arrangement.

## Integration Boundary

Keep the synth app isolated from optical recognition details behind this API:

```ts
export async function parseSheetMusicToMidi(file: File): Promise<{
  midiData: ArrayBuffer;
  fileName: string;
  warnings: string[];
}>;
```

Everything downstream should continue to treat the result as a normal MIDI file. This preserves the existing worker parser, per-track synth nodes, transport, timeline, SoundFont playback, and WAV export flow.

The sheet image preview is UI state only. It should not become a separate playback source or alter the MIDI worker contract.

## UI Flow

1. The user chooses `Upload Sheet` and selects a JPG/PNG, or presses `Sweden`.
2. `midireader.tsx` stores the image as `selectedSheetMusicImage` and displays it under `Displayed sheet music`.
3. The user presses `Convert MIDI`.
4. `parseSheetMusicToMidi(...)` returns a MIDI `ArrayBuffer`, filename, and warnings.
5. The generated MIDI is loaded through `loadMidiIntoTracks(...)` with `sourceKind: "generated"`.
6. The app displays generated MIDI metadata and the usual transport/timeline controls.

The file input still uses the accessible label `Scan or upload sheet music` for test and UI compatibility, but the visible workflow is now preview-first rather than scan-immediately.

## Persistence Logic

MIDI persistence remains centered on `CURRENT_MIDI_STORAGE_KEY` in `src/midireader.tsx`.

- Bundled MIDI files persist by `{ kind: "bundled", name, path, currentSec }`.
- Uploaded and generated MIDI files persist as a `dataUrl` only when the MIDI buffer is at or below `MAX_PERSISTED_MIDI_BYTES` (`4 * 1024 * 1024` bytes).
- Playback position is updated through `updatePersistedMidiTime(...)`.
- On startup, the app restores bundled MIDI from the manifest path, or uploaded/generated MIDI from the persisted `dataUrl`.
- Persisted loads pass `persist: false` into `loadMidiIntoTracks(...)` to avoid rewriting storage during restore.

Sheet image preview persistence is intentionally not implemented:

- `selectedSheetMusicImage` is transient React state.
- Object URLs are browser-session resources and are revoked by cleanup.
- `sweden.jpg` can always be reloaded from the bundled asset through the `Sweden` button.
- User-uploaded sheet images are not written to localStorage because camera photos can be large and localStorage is already reserved for the generated MIDI output.

In practice, after a sheet image is converted, the generated MIDI may survive reloads if it is small enough for the existing generated-MIDI persistence path. The displayed JPG/PNG preview itself does not survive reloads.

## Why This Boundary Matters

The synth app already has robust MIDI ingestion. Sheet music recognition should only be responsible for converting an image into a MIDI buffer. It should not create a new playback path, a new synth path, or a separate timeline format unless there is a later need to display notation-specific diagnostics.

## Next Milestones

1. Improve image preprocessing.

   - Add blur and low-resolution warnings.
   - Estimate and correct skew.
   - Improve contrast normalization for uneven lighting.

2. Improve staff and system detection.

   - Segment systems and measures.
   - Detect grand-staff pairs.
   - Handle partial/cropped staves.

3. Expand symbol recognition.

   - Detect noteheads, stems, beams, rests, clefs, accidentals, key signatures, and time signatures.
   - Start with monophonic or simple piano scores before trying dense polyphony.
   - Produce an intermediate notation model before MIDI encoding.

4. Quantize notation into musical events.

   - Resolve pitch from clef, staff position, key signature, accidentals, and octave context.
   - Resolve duration from notehead, stem, beam, flag, dot, tie, and measure context.
   - Preserve voices where possible.

5. Improve MIDI encoding from the notation model.

   - Reuse the app's existing MIDI parser expectations.
   - Generate format-1 MIDI with a conductor track and one or more instrument tracks.
   - Include tempo and time-signature meta events.

6. Move expensive parsing into a worker.

   - Add `src/sheet-music.worker.ts` once recognition becomes CPU-heavy.
   - Transfer image buffers and MIDI buffers instead of cloning large data.
   - Report progress stages back to `midireader.tsx`.

7. Improve UI diagnostics.

   - Keep the preview-first sheet image workflow in the MIDI toolbar.
   - Show neutral warnings separately from errors.
   - Consider a review panel for detected measures, confidence, and skipped symbols.

## Testing Strategy

Keep tests focused on the contract:

- The adapter returns an `ArrayBuffer`.
- The buffer starts with `MThd`.
- The existing `parseMidiBuffer(...)` can parse the result.
- Image files are accepted.
- Non-image files are rejected.
- The UI displays a selected JPG/PNG before conversion.
- The `Sweden` sample displays `sweden.jpg` and converts to generated MIDI.
- Generated sheet MIDI loads through the normal metadata/transport path.

When real recognition lands, add fixture images and assert stable musical output at the notation-model layer before asserting exact MIDI bytes.

## Open Questions

- Should the recognition target only piano grand staff first, or support single-staff melodies first?
- Should the app preserve a notation preview/debug layer, or only import MIDI?
- Should `~/sheet_music_reader` become a local package dependency once it has real parser code, or should the parser remain vendored in this app?
- What image formats and maximum image sizes should be supported on mobile?
