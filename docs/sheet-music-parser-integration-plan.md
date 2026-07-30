# Sheet Music Parser Integration Plan

## Current Status

The app has a `Scan Sheet` camera/photo input in the MIDI toolbar. It accepts image files and routes the resulting MIDI into the existing MIDI playback path through `loadMidiIntoTracks(...)`.

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

This is still a conservative first-pass recognizer. It assumes treble clef and quarter-note timing for detected notes. It does not yet detect clefs, key signatures, accidentals, rests, stems, beams, dots, ties, multiple voices, or piano grand-staff relationships.

Implemented files:

- `src/sheet-music-reader.ts`
- `src/midireader.tsx`
- `src/styles.css`
- `test/sheet-music-reader.test.ts`

Verified with:

- `npm run typecheck`
- `npm test`
- `npm run build`

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

   - Keep the `Scan Sheet` button in the MIDI toolbar.
   - Show neutral warnings separately from errors.
   - Consider a review panel for detected measures, confidence, and skipped symbols.

## Testing Strategy

Keep tests focused on the contract:

- The adapter returns an `ArrayBuffer`.
- The buffer starts with `MThd`.
- The existing `parseMidiBuffer(...)` can parse the result.
- Image files are accepted.
- Non-image files are rejected.

When real recognition lands, add fixture images and assert stable musical output at the notation-model layer before asserting exact MIDI bytes.

## Open Questions

- Should the recognition target only piano grand staff first, or support single-staff melodies first?
- Should the app preserve a notation preview/debug layer, or only import MIDI?
- Should `~/sheet_music_reader` become a local package dependency once it has real parser code, or should the parser remain vendored in this app?
- What image formats and maximum image sizes should be supported on mobile?
