## SF2 + MIDI Explorer Architecture

This project is a React + Vite web app for:
- exploring SoundFont2 (`.sf2`) data,
- loading and visualizing MIDI files,
- playing MIDI through a custom SF2 AudioWorklet synth,
- monitoring audio via shared analyzer graphs.

## High-Level Modules

### Orchestral dynamics

The analyzer sidebar has a **Dynamic compression** control with **Epic orchestra**
(default), **Gentle orchestra**, and **Off**. The selection is saved locally and
applies to MIDI file playback, live keyboard/MIDI notes, and WAV exports. Raw SF2
sample previews remain unprocessed. External MIDI output is unaffected.

`src/master-dynamics.ts` provides the shared stereo DSP: a soft-knee RMS compressor,
a 70 Hz detector high-pass, adaptive release, and a stereo-linked lookahead limiter.
Epic uses a −22 dB threshold, 2:1 ratio, 12 dB knee, 25 ms attack, up to 450 ms release,
and 3 dB makeup gain. Gentle uses −18 dB, 1.5:1, 12 dB, 35 ms, up to 550 ms, and 1.5 dB.
The limiter holds sample peaks below −1 dBFS; it is not an oversampled true-peak
limiter. Off bypasses both stages. Mode changes are smoothed over 20 ms.

`src/master-dynamics-processor.ts` runs once after all tracks are mixed, before
the analyzer and output. Live audio has 5 ms of lookahead latency in every mode;
offline mastering removes that delay and flushes the tail before WAV encoding.
The reduction meter shows compression, with a separate indication when limiting
is active. Export captures the mode selected when Export WAV is clicked.

### Synth and MIDI modules

- `src/App.jsx`
  - Main app shell, tab layout (`MIDI Explorer` / `SF2 Explorer`), toolbar.
  - Owns global audio infrastructure (`AudioContext`, `AnalyserNode`).
  - Loads/parses SF2 files via `parseSF2`.
  - Manages live MIDI input driver and keyboard note triggers.
  - Provides shared callbacks/props to `MidiReader`.

- `src/midireader.jsx`
  - MIDI explorer UI: timeline, track rows, play/pause/timer, per-track program select.
  - Creates per-track `AudioWorkletNode("sf2-processor")`.
  - Transfers each track node’s `MessagePort` to worker.
  - Sends MIDI binary to worker as transferable `ArrayBuffer`.
  - Receives worker timing/song state and updates UI/playhead.

- `src/midi-timer.worker.js`
  - Worker-thread MIDI parser + scheduler.
  - Parses MIDI events/tempo/time signature in worker.
  - Owns playback clock and event dispatch loop.
  - Sends `noteOn`/`noteOff` directly to transferred processor ports.
  - Requests program mapping from main thread when needed.

- `src/sf2-processor.js`
  - AudioWorklet processor implementing SF2 region playback.
  - Voice allocation, envelopes, loop handling, filtering, modulation.
  - Receives `setPreset`, `noteOn`, `noteOff` via message port.

- `sf2-parser.js` and `sf2parser.js`
  - SF2 file parser and region builder.
  - Produces regions consumable by `sf2-processor`.

- `src/midi-driver.js`
  - Web MIDI input handling for live controller events.
  - Supports note on/off, bank select, and program change callbacks.

## Runtime Data Flow

1. SF2 load:
   - `App.jsx` fetches/reads `.sf2` -> `parseSF2(...)`.
   - Regions are generated per preset and cached.

2. Audio setup:
   - `App.jsx` creates `AudioContext` + shared `AnalyserNode`.
   - Worklet module `sf2-processor.js` is loaded once.
   - Analyzer panel is always visible and uses shared analyzer buffers.

3. MIDI file playback:
   - `midireader.jsx` sends MIDI `ArrayBuffer` to worker (`loadMidi`).
   - Worker parses MIDI, computes song metadata + event timelines.
   - Main thread creates one worklet node per track and transfers ports (`attachPorts`).
   - Worker drives timing and emits note events directly to track ports.

4. Program selection:
   - Worker emits `programChangeRequest` (`program`, `bank`, `trackIndex`).
   - Main resolves to SF2 preset index and returns `setTrackPreset` with regions.
   - Track selector overrides use same mechanism.

5. Live MIDI/keyboard:
   - `midi-driver.js` and keyboard handlers call `noteOn/noteOff` against main synth node.

## Worker Protocol (Main <-> Worker)

- Main -> Worker:
  - `loadMidi` (`midiData: ArrayBuffer`, transferable)
  - `attachPorts` (`[{ trackIndex, port }]`, ports transferable)
  - `play`, `pause`, `seek`
  - `setTrackPreset` (`trackIndex`, `presetIndex`, `override`, `regions`)

- Worker -> Main:
  - `songLoaded` (parsed timeline model)
  - `tick` (playback time updates)
  - `paused`, `ended`
  - `programChangeRequest`
  - `error`

## UI Layout

- Top toolbar:
  - Audio power state/control
  - MIDI connect + input selection
- Tabs:
  - `MIDI Explorer`
  - `SF2 Explorer`
- Fixed right analyzer panel:
  - Time-domain and frequency-domain snapshots

## Build & Deploy

- Dev:
  - `npm install`
  - `npm run dev`

- Build:
  - `npm run build`

- Vite base:
  - Dev: `/`
  - Production build: `/gbk/` (for GitHub Pages project site)

- GitHub Actions:
  - `.github/workflows/deploy-pages.yml`
  - On push to `main`: build + deploy `dist` to GitHub Pages.
# gbk
