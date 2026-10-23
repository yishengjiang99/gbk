## SF2 + MIDI Explorer Architecture

This project is a React + Vite web app for:
- exploring SoundFont2 (`.sf2`) data,
- loading and visualizing MIDI files,
- playing MIDI through a custom SF2 AudioWorklet synth,
- monitoring audio via shared analyzer graphs.

## High-Level Modules

### Master output

All audio goes through the SF2 engine's own master stage only (`src/sf2/master-bus.ts`):
gain (−3 dB default), stereo-linked compressor, lookahead brickwall limiter (−0.3 dBFS) and a
safety soft clip. The app no longer has a separate dynamics stage. The Winamp volume knob maps to
the engines' `masterGainDb` (full volume = −3 dB, `volumeToMasterGainDb`).

Per-track CC7 volume, CC10 pan and CC11 expression knobs are sent as `setControllers` and written
into the engine's MIDI channel controller state, so they act through the SF2 2.01 default
modulators (CC7/CC11 → 960 cB concave attenuation, CC10 → pan).

### MIDI clock follower demo

`midi-clock.html` follows MIDI Clock (F8/FA/FB/FC) from Web MIDI or a built-in synthetic source: a Worker estimates
BPM and beat phase, and an AudioWorklet (`src/midi-clock/click-processor.ts`) schedules a click on the audio clock.
See `docs/midi-clock-follower.md` (clock-domain conversion, sync-lost timeout, teardown) and
`docs/midi-clock-experiment.md` (estimator comparison, `npm run experiment:midi-clock`).

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

- `src/sf2-renderer.ts` + `src/sf2/*` (SoundFont 2.01 engine)
  - `Sf2SynthEngine`: a SoundFont 2.01 compliant synthesis model, ported from sf2player-swift `.spec`. There is no legacy mode.
    Coverage is in docs/SF2_COMPLIANCE.md (80 pass, 3 n/a), and each row is backed by `test/sf2-compliance-*.test.ts`.
  - Master bus (non-normative, after the voices and fx): `masterGainDb` (default -3 dB), a compressor
    (-6 dBFS, 4:1, 6 dB knee, 5/100 ms), a lookahead brickwall limiter (-0.3 dBFS), and a safety soft clip.
    Output never reaches ±1.0. Turn it off with `engine.masterDynamicsEnabled = false`, and tune it with
    `engine.master.setParams({...})`. It adds 1.5 ms of latency. The WAV writers clamp to ±1 before int16.
  - Cross-engine parity vs Swift: `SF2_PARITY_SWIFT_BIN=… npm test`. See `test/sf2-cross-engine-parity.test.ts`.

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


## Workstation + WebMCP (agent tools)

GBK opens on an editable **workstation**: tick-based piano roll, CC / pitch-bend automation lanes, transport, and an
agent activity / proposal panel. The original player, playlist, SoundFont explorer, Bach generator, sheet music and
recorder live under **Player / Library** (a modal; the audio engine stays mounted).

- Edit by hand: drag to select a range, drag notes to move, drag the note end to resize, double-click to add/delete,
  arrows transpose / scroll, alt+arrows nudge, +/- zoom, Delete removes. Lanes: click adds a point, drag moves,
  alt-click deletes, shift-drag draws. Undo/Redo share one history with agents.
- **Enable Agent Tools** registers `gbk_*` tools with WebMCP (`document.modelContext`, Chrome with WebMCP enabled).
  Agents stage *proposals*; you audition A/B and press **Accept** or **Reject**. Off by default; GBK works without it.
- Timed CC (all 0–127), 14-bit pitch bend and pressure now play, seek, loop, export to MIDI/WAV and MIDI-out consistently.

Docs: [architecture](docs/architecture.md) · [WebMCP tools](docs/webmcp.md) · [controller pipeline](docs/controller-pipeline.md) ·
[demo walkthrough](docs/demo-walkthrough.md).

## Songs
Songs made with GBK's agent tools are published in [`songs/`](songs/) and shown at
<https://yishengjiang99.github.io/gbk/songs/>. Publish one with `npm run song:publish -- songs/recipes/<name>.json`; see [docs/songs.md](docs/songs.md).
