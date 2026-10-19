# MIDI Clock follower demo

Page: `midi-clock.html` (built as the `midi-clock` Vite input; dev URL `/gbk/midi-clock.html`). Code: `src/midi-clock/`.
Framework-free: plain TypeScript, DOM, Web MIDI, a Worker and an AudioWorklet.

```
Web MIDI input ──┐                       ┌─ status (≈20 Hz + on change) ─┐
                 ├─ [code, ts] ──► Worker (FilteredEstimator + transport)   ▼
Synthetic source ┘     main thread        main thread: perf ms → audio s ──► AudioWorklet "midi-click"
                                                                  schedule msg   (ClickScheduler)
```

| Module | Role | Pure? |
|---|---|---|
| `clock-estimator.ts` | `LastIntervalEstimator` (baseline) / `FilteredEstimator` (rolling median + phase correction) | yes |
| `transport.ts` | Start/Continue/Stop/Clock state machine, sync-loss detection, status snapshot | yes |
| `clock-domain.ts` | time-domain conversion helpers | yes |
| `click-scheduler.ts` | picks which beat fires in which render quantum, synthesises the click, keeps the click log | yes (no worklet globals) |
| `trace.ts`, `synthetic-source.ts` | seeded traces / synthetic MIDI source | yes (timers injected) |
| `clock-worker-core.ts` / `midi-clock.worker.ts` | worker logic / thin Worker shell | core yes |
| `click-processor.ts` | `AudioWorkletProcessor` shell around `ClickScheduler` | – |
| `follower.ts`, `midi-input-manager.ts`, `main.ts` | main-thread wiring (dependencies injected, so teardown is tested with fakes) | – |

## Transport semantics

- `F8` clock: 24 per quarter note. Clocks update tempo/phase even while stopped (many devices keep clocking).
- `FA` Start: song position 0; the **next clock after Start is tick 0**. A second Start before any clock arrives is the same command delivered twice and is ignored; a Start while running restarts at 0.
- `FC` Stop: halts clicks and remembers the position (last tick + 1). A repeated Stop is ignored.
- `FB` Continue: the next clock is the remembered position. The first click is the next beat boundary at or after that position (`firstBeat = ceil(pos / 24)`). Continue with no previous Start begins at 0.
- Missing clocks: a gap is read from the timestamp (`round(dt / period)` ticks), so the song position stays right. Duplicated clocks (same timestamp, or a late message followed by its clump) are dropped and never advance the position.
- Tempo change (for example 120 → 90 BPM): two consecutive ticks more than 8 ms off the predicted grid trigger a resync; the test converges to within 1 BPM in under 1.5 s.

## Clock-domain conversion

Three time bases are involved:

| Domain | Unit / origin |
|---|---|
| Web MIDI `MIDIMessageEvent.timeStamp` = main-thread `performance.now()` | ms since the main window `timeOrigin` |
| Worker `performance.now()` | ms since the **worker's** `timeOrigin` (different) |
| `AudioContext.currentTime` (also `currentTime` inside the worklet) | seconds since the context was created |

1. **MIDI → worker.** Timestamps are forwarded unchanged in the main `performance.now()` domain. The worker never needs its own clock for event maths; it only needs "now" for the watchdog, and gets it as `workerNow + (worker.timeOrigin − mainTimeOrigin)` (`workerToMainMs`, with `mainTimeOrigin` passed in the `init` message).
2. **Main → audio.** `AudioContext.getOutputTimestamp()` returns `{contextTime, performanceTime}` describing the same instant (the sample currently leaving the device). `ClockDomainMap` samples it every 100 ms, stores `offset = performanceTime/1000 − contextTime`, and uses the **median of the last 15 offsets** to remove quantisation noise: `audioTime = perfMs/1000 − offset`.
3. **Why there is no extra output-latency term.** A sound rendered at audio time T is audible when the output timestamp reaches T, which is exactly the instant `getOutputTimestamp` maps to T. A click scheduled at the converted time of a MIDI beat is therefore heard on that beat.
4. **Scheduling.** The worker reports one beat boundary on its estimated grid (`anchorBeat`, `anchorMs`) plus the beat period. The main thread converts the anchor and posts it to the worklet. In each render quantum the worklet computes the time of the next unfired beat (`anchor + (k − anchorBeat) * period`) and fires it, sample-accurately, when it falls inside the quantum. Beats are tracked by number (`lastFired`), so a refreshed anchor can never fire a beat twice; a new `runId` (every Start/Continue) resets that bookkeeping.
5. **Beat 0 is late by design.** A click for an event that has only just been received cannot be rendered in the past: beat 0 after Start is late by transport hops plus output latency (37.7 ms in the headless run). Later beats are predicted ahead and land on time. A beat that is more than `LATE_TOLERANCE_S` (120 ms) late when its schedule arrives is skipped, not fired.

## Sync-lost timeout

- `SYNC_LOST_TIMEOUT_MS = 250` of silence after at least one clock was seen ⇒ **sync lost** (`lostReason: "timeout"`). 250 ms is 12 ticks at 120 BPM and still more than 3 ticks at 30 BPM, so ordinary jitter, 20 ms delays and a few missing clocks never trip it.
- The worker's watchdog runs every `WATCHDOG_POLL_MS = 50`, so loss is reported at most 250 + 50 = 300 ms after the last clock (requirement: 500 ms). `test/midi-clock-transport.test.ts` measures it through `ClockWorkerCore` with fake timers.
- A Web MIDI port that disappears is reported immediately (`INPUT_DISCONNECTED`, `lostReason: "disconnect"`).
- **Stays-stopped policy.** On loss the transport stops (clicks cease at once) and the estimator is reset. When clocks come back, sync is `locked` again but the transport stays **stopped** until the master sends Start or Continue. Reason: after a gap the song position is unknown, so guessing would put clicks on the wrong beat. The remembered stop position is kept for a Continue.

## Teardown and listener audit

`MidiClockFollower.dispose()` (also called on `pagehide`) is idempotent and releases, in order:

| Resource | Released by |
|---|---|
| synthetic source timer | `SyntheticMidiSource.disconnect()` |
| Web MIDI `midimessage` listener(s) and the `statechange` listener | `MidiInputManager.dispose()` |
| domain-sampling and click-log flush timers | `clearInterval` |
| Worker | handler cleared, `{type:"dispose"}` sent (worker clears its watchdog interval and calls `close()`), `terminate()` |
| click node `MessagePort` | `onmessage = null`, `port.close()`, `node.disconnect()` |
| `AudioContext` | `close()` (skipped if already closed) |
| `requestAnimationFrame` loop | cancelled in `main.ts` |

A `start()` that races with `dispose()` creates no node and leaves no open context. Hot-plug: `MidiInputManager` keeps at most one attached input and a single stable handler; `statechange` storms, re-selection and re-enumeration after replug are idempotent, and unplug is reported once. Covered by `test/midi-clock-follower.test.ts`.

## AudioWorklet render-loop allocation audit

`ClickScheduler` preallocates every buffer and scalar in its constructor (voice state and a 512-click ring log). `process()` and `trigger()` contain no `new`, array/object literals, closures, template strings, spreads, allocating array methods or `postMessage`; `MidiClickProcessor.process()` just forwards `currentTime` and the two output channels. Clicks are logged into the ring; the main thread asks for the log with a `flush` message and the **message handler** (not `process()`) copies it out. The unavoidable allocations are in message handlers (structured clone of incoming `schedule` messages, the `flush` reply), which run outside the render quantum.

Evidence (`test/midi-clock-click.test.ts`): a static scan of both `process()` bodies and `trigger()` for forbidden constructs (verified to fail when an array literal is injected), and a run of 200 000 render blocks (about 9 minutes of audio, over 1000 clicks) whose heap growth was 35 136 bytes in the recorded run (a 32-byte allocation per block would have grown it by about 6 MB).

## Verifying

- Unit tests: `npm test` (the `midi-clock-*.test.ts` files).
- Experiment: `npm run experiment:midi-clock` → `docs/midi-clock-experiment.md`.
- Browser (synthetic source, headless Chromium): `MIDI_CLOCK_SOAK_MS=120000 npx playwright test test/e2e/midi-clock.spec.ts --project=chromium`.
