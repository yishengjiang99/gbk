# Sheet Music Parser Integration Plan

## Current Status

The app now has a `Scan Sheet` camera/photo input in the MIDI toolbar. It accepts image files and routes the resulting MIDI into the existing MIDI playback path through `loadMidiIntoTracks(...)`.

The current parser adapter is an MVP bridge, not full optical music recognition. It vendors the dependency-free Sweden transcription MIDI generator from `~/sheet_music_reader` into `src/sheet-music-reader.ts` and returns a parseable MIDI `ArrayBuffer`.

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

1. Replace the demo transcription with real image preprocessing.

   - Decode the uploaded image with `createImageBitmap`.
   - Normalize scale, contrast, and orientation.
   - Convert to grayscale or thresholded canvas data.
   - Return actionable warnings for low resolution, blur, or skew.

2. Add staff and system detection.

   - Detect staff-line groups.
   - Estimate staff spacing.
   - Deskew the page when needed.
   - Segment systems and measures.

3. Add symbol recognition.

   - Detect noteheads, stems, beams, rests, clefs, accidentals, key signatures, and time signatures.
   - Start with monophonic or simple piano scores before trying dense polyphony.
   - Produce an intermediate notation model before MIDI encoding.

4. Quantize notation into musical events.

   - Resolve pitch from clef, staff position, key signature, accidentals, and octave context.
   - Resolve duration from notehead, stem, beam, flag, dot, tie, and measure context.
   - Preserve voices where possible.

5. Encode MIDI from the notation model.

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
