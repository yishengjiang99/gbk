# AGENTS.md

## Project Summary

This repo is a Vite + React app for inspecting SoundFont 2 (`.sf2`) files, loading MIDI files, playing them through a custom SF2 synth, and exporting rendered audio. The core audio engine is not a third-party synth library: MIDI parsing, scheduling, SF2 region building, and synthesis are implemented in this repo.

## Commands

- `npm install`
- `npm run dev`
- `npm run build`
- `npm run preview`

`dev` and `build` both regenerate [`public/static/midi-manifest.json`](/Users/yishengj/synth/public/static/midi-manifest.json) from the `.mid` files under [`public/static`](/Users/yishengj/synth/public/static) via [`scripts/generate-midi-manifest.mjs`](/Users/yishengj/synth/scripts/generate-midi-manifest.mjs).

## Top-Level Structure

- [`src/App.jsx`](/Users/yishengj/synth/src/App.jsx): main app shell, audio setup, SF2 loading/parsing, live MIDI driver hookup, tab state, analyzer state.
- [`src/midireader.jsx`](/Users/yishengj/synth/src/midireader.jsx): MIDI explorer UI, transport, track controls, worker coordination, per-track synth nodes, offline export flow.
- [`src/midi-timer.worker.js`](/Users/yishengj/synth/src/midi-timer.worker.js): parses MIDI in a worker, builds the playback model, owns transport timing, dispatches note/program events.
- [`src/sf2-processor.js`](/Users/yishengj/synth/src/sf2-processor.js): AudioWorklet synth engine. Voice allocation, envelopes, looping, filter/modulation, CC mix handling happen here.
- [`src/sf2-renderer.js`](/Users/yishengj/synth/src/sf2-renderer.js): offline rendering path used for WAV export.
- [`src/midi-driver.js`](/Users/yishengj/synth/src/midi-driver.js): Web MIDI input bridge for live controllers.
- [`sf2-parser.js`](/Users/yishengj/synth/sf2-parser.js): SoundFont parser plus preset region builder consumed by the runtime.
- [`src/styles.css`](/Users/yishengj/synth/src/styles.css): single main stylesheet for the UI.
- [`public/static`](/Users/yishengj/synth/public/static): bundled demo `.sf2` and `.mid` assets.
- [`guide/driver.js`](/Users/yishengj/synth/guide/driver.js): reference/demo snippet for driving the worklet directly; not part of the main app path.

## Runtime Architecture

There are three distinct execution contexts:

1. Main thread React app:
   Loads the SF2, creates the `AudioContext`, registers the worklet module, resolves presets, creates track nodes, and owns the UI.
2. Web Worker:
   Parses MIDI and drives the playback clock so timing is not coupled to React rendering.
3. AudioWorklet processor:
   Receives regions and note events, then generates audio sample-by-sample.

When debugging playback, check all three layers. Many bugs are boundary bugs rather than pure UI bugs.

## Important Data Flow

- SF2 load: [`src/App.jsx`](/Users/yishengj/synth/src/App.jsx) fetches or reads an `.sf2`, then calls `parseSF2(...)` from [`sf2-parser.js`](/Users/yishengj/synth/sf2-parser.js).
- Preset resolution: the app resolves MIDI `program` + `bank` to a preset index, then builds transfer-ready `regions`.
- MIDI load: [`src/midireader.jsx`](/Users/yishengj/synth/src/midireader.jsx) sends the raw MIDI `ArrayBuffer` to [`src/midi-timer.worker.js`](/Users/yishengj/synth/src/midi-timer.worker.js).
- Worker scheduling: the worker emits `programChangeRequest` messages and sends `noteOn` / `noteOff` directly to transferred worklet `MessagePort`s for each track.
- Audio render: [`src/sf2-processor.js`](/Users/yishengj/synth/src/sf2-processor.js) turns preset regions plus note events into stereo output.
- Export: [`src/midireader.jsx`](/Users/yishengj/synth/src/midireader.jsx) uses [`src/sf2-renderer.js`](/Users/yishengj/synth/src/sf2-renderer.js) to render offline and encode a WAV in chunks.

## MIDI Signal Paths

There are two main note/event pathways in this app, and they are intentionally different.

### 1. Live MIDI Input Path

This is the path for a hardware keyboard/controller or the app's direct note triggering:

1. [`src/midi-driver.js`](/Users/yishengj/synth/src/midi-driver.js) receives browser `midimessage` events.
2. It decodes note on/off, bank-select CCs, and program changes, then calls callbacks supplied by [`src/App.jsx`](/Users/yishengj/synth/src/App.jsx).
3. [`src/App.jsx`](/Users/yishengj/synth/src/App.jsx) handles those callbacks on the main thread:
   - `onProgramChange` resolves the requested bank/program to a preset index and pushes `setPreset` to the main synth node.
   - `onNoteOn` and `onNoteOff` post directly to the main worklet node port.
4. [`src/sf2-processor.js`](/Users/yishengj/synth/src/sf2-processor.js) renders audio immediately.

Important properties of the live path:

- No worker is involved for note scheduling.
- It uses one main synth node owned by [`src/App.jsx`](/Users/yishengj/synth/src/App.jsx), not the per-track nodes from the MIDI file player.
- Bank/program state is driven from incoming MIDI controller/program messages.
- Bugs here usually live in [`src/midi-driver.js`](/Users/yishengj/synth/src/midi-driver.js), preset resolution in [`src/App.jsx`](/Users/yishengj/synth/src/App.jsx), or note handling in [`src/sf2-processor.js`](/Users/yishengj/synth/src/sf2-processor.js).

### 2. MIDI File Playback Path

This is the path for `.mid` files loaded in the MIDI Explorer:

1. [`src/midireader.jsx`](/Users/yishengj/synth/src/midireader.jsx) loads a MIDI file and transfers its `ArrayBuffer` to [`src/midi-timer.worker.js`](/Users/yishengj/synth/src/midi-timer.worker.js) with `loadMidi`.
2. The worker parses tracks and events into `playEvents`, computes tempo/time-signature timing, and sends back `songLoaded`.
3. [`src/midireader.jsx`](/Users/yishengj/synth/src/midireader.jsx) creates one `AudioWorkletNode` per track, connects them through gain/pan nodes, then transfers each node's `MessagePort` back to the worker with `attachPorts`.
4. When playback starts, the worker runs the timer loop, advances `nextEventIndex` per track, and emits:
   - `programChangeRequest` to the main thread when a track needs a preset and no manual override is active.
   - direct `noteOn` / `noteOff` messages to that track's transferred port.
5. [`src/midireader.jsx`](/Users/yishengj/synth/src/midireader.jsx) resolves `programChangeRequest` into regions and sends `setTrackPreset` back to the worker, which forwards `setPreset` to the track's processor port.
6. Each per-track instance of [`src/sf2-processor.js`](/Users/yishengj/synth/src/sf2-processor.js) renders its own track audio.

Important properties of the MIDI file path:

- Timing is worker-driven, with a small lookahead loop in [`src/midi-timer.worker.js`](/Users/yishengj/synth/src/midi-timer.worker.js).
- Playback uses per-track synth nodes, not the live-input synth node.
- Program changes found inside the MIDI file are resolved lazily during playback unless the user has set a manual track override.
- Seeking and pausing are worker operations; the worker also sends `noteOff` to stop any currently active notes.

### Practical Debug Rule

If a bug happens only with a hardware controller, inspect the live path first.

If a bug happens only when loading or seeking a `.mid` file, inspect the worker/per-track path first.

If both fail the same way, inspect preset-region construction in [`sf2-parser.js`](/Users/yishengj/synth/sf2-parser.js) or note rendering in [`src/sf2-processor.js`](/Users/yishengj/synth/src/sf2-processor.js).

## Key Files To Inspect Before Editing

- If the prompt mentions transport, seeking, playhead drift, tempo, or track timing:
  inspect [`src/midireader.jsx`](/Users/yishengj/synth/src/midireader.jsx) and [`src/midi-timer.worker.js`](/Users/yishengj/synth/src/midi-timer.worker.js).
- If it mentions wrong instrument, bank/program mapping, missing notes, or SF2 layering:
  inspect [`src/App.jsx`](/Users/yishengj/synth/src/App.jsx) and [`sf2-parser.js`](/Users/yishengj/synth/sf2-parser.js).
- If it mentions clicks, envelopes, looping, pan, CC behavior, or synthesis quality:
  inspect [`src/sf2-processor.js`](/Users/yishengj/synth/src/sf2-processor.js) and [`src/sf2-renderer.js`](/Users/yishengj/synth/src/sf2-renderer.js).
- If it mentions live keyboard/controller behavior:
  inspect [`src/midi-driver.js`](/Users/yishengj/synth/src/midi-driver.js) and the MIDI handling in [`src/App.jsx`](/Users/yishengj/synth/src/App.jsx).
- If it mentions asset lists or missing demo MIDI files:
  inspect [`scripts/generate-midi-manifest.mjs`](/Users/yishengj/synth/scripts/generate-midi-manifest.mjs).

## Project-Specific Caveats

- [`vite.config.js`](/Users/yishengj/synth/vite.config.js) currently sets `base: "/gbk/"`. That is correct for GitHub Pages deployment but can matter if prompts involve asset URL handling.
- [`index.html`](/Users/yishengj/synth/index.html) loads [`public/fontawesome-local.css`](/Users/yishengj/synth/public/fontawesome-local.css) from an absolute path. Be careful when changing base paths or static asset references.
- The app depends on browser-only APIs: `AudioContext`, `AudioWorklet`, Web Workers, and Web MIDI. Some features cannot be meaningfully validated in a plain Node test environment.
- The audio engine passes large buffers and ports across boundaries. Be careful with transferables, cloning cost, and object shapes.
- There is no formal test suite in the repo today. Verification is mainly by build success and targeted browser/manual testing.
- The README architecture summary is useful, but the code is the source of truth if they diverge.

## Prompting Guidance For Future Agents

- Assume this is a browser audio app first, not a generic React CRUD app.
- When making playback changes, trace the full path: UI -> worker message -> preset resolution -> processor message -> audio output.
- Avoid replacing the custom synth path with external libraries unless explicitly requested.
- Preserve the generated manifest flow; do not hand-edit [`public/static/midi-manifest.json`](/Users/yishengj/synth/public/static/midi-manifest.json) unless there is a specific reason.
- Keep edits compatible with Vite and ESM.
- Prefer small, boundary-aware fixes. Seemingly local changes in MIDI or SF2 handling often have cross-thread consequences.

## Verification Expectations

After non-trivial changes, prefer:

- `npm run build`
- Manual browser verification for the affected path

For audio changes, verify both live playback and exported rendering when relevant, because the real-time worklet path and offline renderer can diverge.
