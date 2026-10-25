# Live MIDI input: the shared event format and recording format (web + iOS)

This document is the contract for hardware keyboards (Web MIDI on web, CoreMIDI on iOS), the on-screen keys and the computer keys. All of them produce the same **live events**. A recorded take maps them onto the **existing project schema** (`src/workstation/model.ts`). No new storage format is introduced.

Web code: `src/workstation/midi-input.ts` (devices and hot-plug) and `src/workstation/live-input.ts` (`LiveInputSession`: routing, sustain, recording).

## 1. Live events

```ts
type LiveEvent =
  | { type: "noteOn";    channel: number; note: number; velocity: number; t: Stamp } // velocity 1..127
  | { type: "noteOff";   channel: number; note: number; velocity: number; t: Stamp } // release velocity 0..127 (default 64)
  | { type: "cc";        channel: number; controller: number; value: number; t: Stamp } // 0..127
  | { type: "pitchBend"; channel: number; bend: number; t: Stamp };                    // -8192..8191, 0 = centre
interface Stamp { sec: number; beats: number } // both relative to record start (or session start when not recording)
```

**Values**
- `channel` is 0–15, taken from the device. Input is **omni**: every channel plays into the selected track, on that track's channel.
- A `noteOn` with velocity 0 is a `noteOff`, per the MIDI spec.
- Pitch bend on the wire is 14-bit, 0..16383. The live event carries it signed: `bend = raw - 8192`. The project stores it unsigned (`PitchBendEvent.value` 0..16383, 8192 = centre), so `value = bend + 8192`.
- CC 120 (all sound off) and CC 123 (all notes off) cause a panic: every held note is released. They are neither forwarded nor recorded.

**Timestamps**
- `sec` is wall-clock seconds since record start, taken from the event's `timeStamp` (`performance.now()` domain) when available.
- `beats` is `sec` converted through the project tempo map from the playhead position at record start: `tickNow / ppq`, where `tickNow = secToTick(project, tickToSec(project, startTick) + sec)`.
- Recording is always quantised to integer ticks at the project PPQ. Default PPQ is 480, which is about 1 ms at 120 BPM.

## 2. Sustain (CC64)

- CC64 ≥ 64 means the pedal is **down**; < 64 means **up**.
- While the pedal is down, a `noteOff` is **held**:
  - The note keeps sounding.
  - Its recorded duration keeps growing.
  - The held note is remembered.
- On pedal up, every held note is released at the pedal-up time. The sound stops (`sink.noteOff`) and its recorded duration ends at the pedal-up tick.
- Re-striking a held note while the pedal is down first ends the previous instance at the re-strike tick, then starts the new one.
- CC64 itself is **not** sent to the synth and **not** recorded. The pedal is baked into note durations, so playback, export and the iOS SF2 engine all sound identical without depending on sustain support. This keeps a single source of truth.
- Other CCs are forwarded to the live synth and recorded as CC lanes. CC1 (modulation), CC7, CC10 and CC11 matter most.
- When recording stops or the take ends, any note still held (by key or pedal) ends at the stop tick.

## 3. Mapping a take into the project

A take covers everything between arming record with the transport playing and stop/pause/disarm. It is committed as **one undoable edit** (label `record take (N notes)`) on the selected track `T`, using the existing ops:

| Live | Project op | Fields |
|---|---|---|
| noteOn…noteOff (after sustain) | `addNotes` | `{ trackId: T.id, channel: T.channel, pitch: note, tick, duration ≥ 1, velocity }` |
| cc (≠ 64, 120, 123) | `setCC` (`mode: "merge"`), one op per controller | `{ trackId, channel: T.channel, controller, startTick, endTick, points: [{ tick, value }] }`, last value per tick wins |
| pitchBend | `addPitchBends` | `{ trackId, channel: T.channel, events: [{ tick, value: bend + 8192 }] }` |

The take does not change programs, tempo or time signature. The SF2 instrument is the track's program.

## 4. Live playback

- Events go straight to the SF2 engine for the selected track (`LiveSink`: `noteOn`, `noteOff`, `controlChange`, `pitchBend`, `allNotesOff`), with no scheduling or lookahead. Latency is the audio output latency only.
- Web: the audio context starts on the first gesture, which is the MIDI button tap.
- iOS: should use an `AVAudioEngine` sampler node with the same calls.

## 5. Devices and UI

- **Web.** The **MIDI** button sits next to Keys and Hum.
  - The first tap calls `navigator.requestMIDIAccess({ sysex: false })` and opens the Keys window with an input picker ("All inputs" or one device).
  - `access.onstatechange` keeps the list live (hot-plug); disconnected devices drop out.
  - Without Web MIDI (Safari, iOS WKWebView) the button is disabled and shows "MIDI keyboards need Chrome/Edge or the iOS app". Layout is unchanged and the composer input stays visible.
- **iOS app.** Native CoreMIDI (USB/Bluetooth via `MIDINetworkSession` / BLE) produces the same `LiveEvent`s. Takes are posted to the studio web view as the ops above, so the server project format is identical.
