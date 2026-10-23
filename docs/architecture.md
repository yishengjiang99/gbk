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
