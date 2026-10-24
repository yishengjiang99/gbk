# GBK workstation architecture

```
React UI (src/components/workstation/*)      WebMCP adapter (src/webmcp/*)
        \                                     /
         \--- WorkstationController (src/workstation/controller.ts) ---/   <- single source of truth
                 | project model (model.ts, ticks authoritative)
                 | ops + validation (ops.ts), history, proposals, transport, mix layers
                 | SMF parse/serialize (smf.ts), timing (timing.ts), curves (curves.ts)
                 v
          player-bridge.ts  -->  existing MidiReader (now inside the Player / Library modal)
                                   -> midi-timer.worker.ts (parse, schedule notes + timed CC/bend/pressure)
                                   -> sf2-processor.ts AudioWorklet (Sf2SynthEngine, per-channel controllers)
                                   -> offline WAV (sf2-renderer.ts renderScheduled) / MIDI out (midi-output.ts)
```

- **Layers A–D** of the spec map to: `src/workstation/{model,timing,smf,ops,controller,curves,diff,persistence}.ts` (A, B),
  `src/webmcp/{tools,music-tools,registry,adapter}.ts` (C), `src/components/workstation/*` (D), `src/music/theory.ts`.
- The workstation does not have its own audio path. Playback/preview/WAV serialize the project to SMF and hand it to the
  existing player through `player-bridge.ts`, so the worker/worklet separation and all player features are preserved.
  Project track *i* maps to player track *i+1* (track 0 = conductor).
- **Mix layers:** base defaults (`track.mix`, persisted, undoable) → authored CC automation (project `ccs`) → temporary
  live overrides (`state.overrides`, not persisted, clearable). See `docs/controller-pipeline.md`.
- **Proposals:** `propose(ops)` computes a candidate project without mutating; UI overlays the diff; `commitProposal`
  re-applies ops as one undo entry; agent commits await `approvalHandler` (the Accept button). Any commit/undo/redo bumps
  the revision and marks other pending proposals `stale` (STALE_REVISION on commit).
- **Persistence:** IndexedDB `gbk-midi` v2 adds a `projects` store (v1 `files`/`meta` untouched); autosave on revision
  change; `migrateProject` handles schema versions; restore never clobbers a session's edits.
- **Rendering:** canvas piano roll + lanes, viewport culling, bar/beat LOD, memoized diff/bars, playhead on rAF without
  React re-renders; React only re-renders on controller state changes.


## Headless rendering (src/audio)

```
Project ──structuredClone──▶ RenderJobManager (FIFO, cancel, status)
                              │
   soundfont-loader (cached, /gbk/ base, progress, abort, timeout)
                              ▼
   offline-renderer: buildRenderPlan (sample-frame schedule from tempo map; setup/program/CC/notes, mix as CC7/10/11)
     → offline-context: ONE OfflineAudioContext (webkitOfflineAudioContext fallback) with one sf2-processor
       AudioWorkletNode per audible track (same engine as live playback) → splitter/gain pan matrix → destination;
       suspend() every 2 s of audio = progress + cancellation point; stall (45 s) and overall timeouts
     → BS.1770 loudness + true peak of the rendered buffer, one whole-file gain
     → wav-encoder (PCM16/float32, mono/stereo, 44.1/48 kHz, RF64 for huge files) into one preallocated buffer
     → audio-validation (header, duration, silence, clipping, non-finite) → SHA-256
                              ▼
   artifact-store (IndexedDB "gbk-render-artifacts", bounded range reads) ──▶ ArtifactPanel / WebMCP tools
```
The live player is not involved; Export WAV, `gbk_prepare_wav_export`, `gbk_render_wav` (Composer agent and WebMCP)
and MCP render jobs (`gbk_mcp_render_job`, executed in the user's Studio tab) all share this path. All synthesis runs
on the browser's offline audio thread; the server never renders audio (it only stores uploaded, SHA-256-verified WAVs).
Stop in the Composer sends `cancel_run`; the server forwards `cancel_call` and the tab aborts the job, which parks the
OfflineAudioContext at its next checkpoint (never resumed).
