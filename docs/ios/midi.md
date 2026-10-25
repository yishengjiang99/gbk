# MIDI input on iOS (parity with web Keys / Web MIDI)

## How web does it (read from src/, unchanged)

- `src/workstation/midi-input.ts` `MidiInputManager(navigator, onMessage)`: `supported` = `typeof navigator.requestMIDIAccess === "function"`.
  "Enable MIDI" (Keys panel, `data-testid="midi-enable"`) calls `requestMIDIAccess({sysex:false})`, sets `access.onstatechange`
  for hot-plug, attaches `addEventListener("midimessage")` to every input with `state !== "disconnected"`, device picker "All MIDI inputs"
  or one id. Only `e.data` is used (`timeStamp` ignored). Without the API it shows `MIDI_UNSUPPORTED_MESSAGE` (Safari/iOS).
- `src/components/workstation/LiveKeyboard.tsx` `liveRig()`: one `LiveInputSession` + `Sf2LiveSink` per page; the manager is built with
  the global `navigator`, so a polyfill must exist before the first Keys render (document start is enough).
- `src/workstation/live-input.ts` `LiveInputSession.handleMidi(bytes)` → `parseMidiMessage`: omni (any channel) into the **selected track**.
  Note on (vel 0 = off), note off, CC (120/123 = panic, everything else incl. CC64 sustain and CC1 mod goes to the sink and, when recording,
  to the take), pitch bend 14-bit. Sustain is not interpreted in JS: CC64 is passed to the SF2 worklet (live) and recorded as a `setCC` op.
- Recording: armed + transport playing. Ticks come from the transport position extrapolated by wall time at the moment the message is
  handled (no quantization, no use of the event timestamp). Take = one undoable edit: `addNotes`, `setCC` (merge, last value per tick),
  `addPitchBends` on the track's channel. Live sound: `Sf2LiveSink` (SF2 AudioWorklet in the page).

Shared contract: docs/social/midi-input.md (web Social, 99b1ea9): web's MIDI button next to Keys/Hum calls
`requestMIDIAccess({sysex:false})`; sustain is baked into note durations in JS; record time comes from the event `timeStamp`
(`performance.now()` domain). The shim below satisfies all of that, so the button is enabled (no "unsupported" state) and
takes are produced by web's own code. iOS does **not** post takes as ops (midi-input.md §5 alternative), so there is one recorder.

## iOS

`ios/GBKComposer/Core/MIDI/`:

- `MIDIInputHub`: CoreMIDI client + `MIDIInputPortCreateWithProtocol(._1_0)` (UMP), connects every source (USB / class-compliant,
  `MIDINetworkSession` enabled with policy `.anyone`, Bluetooth LE once paired, virtual), rescans on client notifications (hot-plug).
  Messages are buffered off the CoreMIDI thread; one `DispatchQueue.main.async` flush per run-loop turn → one `evaluateJavaScript` per batch.
- `MIDIMessageParser`: MIDI 1.0 framing (running status, realtime, system common, SysEx dropped) and UMP 0x1/0x2/0x4 → MIDI 1.0 bytes.
  `MIDIEvent` mirrors web `parseMidiMessage` (+ named sustain/mod wheel) for tests.
- `MIDIBridge` + `MIDIBridgeScript`: document-start user script that installs `navigator.requestMIDIAccess` (only inside the app's
  WKWebView, when `webkit.messageHandlers.gbkMidi` exists). Web's own MidiInputManager / LiveInputSession / Sf2LiveSink do everything else,
  so live play and the recorded take format are identical to desktop. Sound stays in web SF2 (no native SF2 live play).
- `BluetoothMIDIPairing`: `CABTMIDICentralViewController` in a modal sheet. Reachable from Profile ⚙︎ → "Bluetooth MIDI…" and from
  web via `window.gbkMidiNative.openBluetoothPairing()`. Nothing is overlaid on the studio.

### Bridge contract

JS → native (`webkit.messageHandlers.gbkMidi.postMessage`): `{type:"request"}` (first `requestMIDIAccess`), `{type:"openBluetooth"}`.

Native → JS:
- `__gbkMidi.devices([{id, name, manufacturer}])` – full list; ids `coremidi-<uniqueID>`; diff fires `statechange` (`e.port`) on access and port;
  removed ports get `state:"disconnected"`. First call resolves `requestMIDIAccess`.
- `__gbkMidi.recv([[id, [status, d1, d2?], ageMs], ...])` – each becomes a `midimessage` event on that input (`onmidimessage` and listeners)
  with `data: Uint8Array` and `timeStamp = performance.now() - ageMs` (ageMs = since CoreMIDI stamped it).
- `__gbkMidi.fail(OSStatus)` rejects pending requests.
- `MIDIAccess`: `inputs` Map, empty `outputs`, `sysexEnabled:false`, `onstatechange`. Channel messages + realtime only.
- Capability flags: `window.gbkNative.capabilities` includes `"midi"` (HumBridge's frozen object), and
  `window.gbkMidiNative = {webMidiPolyfill:true, bluetooth:true, network:true, openBluetoothPairing()}`.

### Web contract requested (GBK Social, not done here)

- Keys panel: when `window.gbkMidiNative?.bluetooth`, render a "Bluetooth MIDI" button next to Enable MIDI that calls
  `window.gbkMidiNative.openBluetoothPairing()`. Until then pairing is in Profile ⚙︎.
- Optional: the device picker could use the event `timeStamp` for record ticks (better than handle time on a busy main thread).

### Latency

Measured in `MIDIBridgeIntegrationTests` (simulator, CI log line `MIDI bridge latency:`): see docs/social/STATUS.md for the number.
Path: CoreMIDI thread → main async → `evaluateJavaScript` → JS dispatch; audio then goes through the page's AudioWorklet
(web reports its own output latency, `~N ms` in Keys).
