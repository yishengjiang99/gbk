# iOS native Hum bridge (web side)

The iOS app records and transcribes a hum on device, then pushes the melody into the studio web view as a **new track named "Hummed melody"**. iOS: `ios/GBKComposer/Features/Create/Hum/HumBridge.swift` and `HumNotesToOps.swift` (a port of `src/hum/notes-to-ops.ts`). Web: `src/hum/native-bridge.ts`, installed with the workstation (`src/workstation/instance.ts`).

## Capability
iOS injects `window.gbkNative = { platform: "ios", version: 1, capabilities: ["hum", ...] }` at document start. When `capabilities` includes `"hum"`:
- the web Hum flow is hidden (toolbar);
- a 🎤 Hum button is shown in the composer prompt bar next to Send (the input stays visible). Tapping it calls `webkit.messageHandlers.hum.postMessage({ type: "toggle" })`.

## `window.gbkHum`
| Method | Contract |
|---|---|
| `context()` | `{ ppq, tempos: [{ tick, microPerQuarter }], tracks: [{ channel }], readOnlyReason: string \| null }` |
| `apply(ops, { label?, selectTrackId? })` | `ops` = exactly `humToOps()` output (see below). Validated, applied as one `workstation.userEdit` (one undo step, label default "hum a melody"), new track selected. Returns `{ ok: true, trackId, notes, revision }` or `{ ok: false, error }` |
| `showReadOnlyHint(reason)` | shows the studio's read-only hint |
| `onState({ phase, elapsed, progress })` | phase `idle` \| `recording` \| `transcribing`; the button shows `🎤 Hum` / `⏺ m:ss Stop` / `🎤 NN%` |

## Ops payload (`humToOps`, `src/workstation/ops.ts` types)
```json
[
  { "op": "addTrack", "id": "<new id>", "name": "Hummed melody", "channel": 1, "program": 0, "bankMsb": 0, "bankLsb": 0, "role": "melody" },
  { "op": "addNotes", "notes": [{ "trackId": "<same id>", "channel": 1, "tick": 0, "duration": 480, "pitch": 60, "velocity": 100 }] }
]
```
Validation (`validateHumOps`): exactly `[addTrack, addNotes]`; id `[A-Za-z0-9_-]{1,64}` not already used; channel integer 0–15 and not 9 (drums); 1–5000 notes, every note on the new track id and channel, integer `tick ≥ 0`, `duration ≥ 1`, `pitch 0–127`, `velocity 1–127`. Times are ticks at the project's `ppq` (iOS converts seconds through `context().tempos`). Name, program 0, bank 0/0 and role `melody` are always forced to the humToOps values. A read-only (shared, not forked) song returns `{ ok: false, error: <reason> }` and shows the hint.

Reference harness: `ios/GBKComposer/Resources/HumTest/hum-harness.html`.
