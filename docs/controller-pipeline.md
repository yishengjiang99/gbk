# Timed controller pipeline (Stage B)

**Before:** `midi-timer.worker.ts` parsed CCs but only used CC0/CC32 (bank select). Every other timed CC, pitch bend
and channel/poly pressure was dropped, notes were posted without a channel, so file automation never reached the
SF2 engine; offline WAV and MIDI-out had the same gap.

**Now:**
- Parser emits `cc` (all controllers except 0/32, which fold into the following program event), `pitchBend` (14-bit),
  `channelPressure`, `polyPressure` play events with their MIDI channel.
- Worker posts them to the **same track worklet port** as that track's notes, carrying the channel; notes now carry
  channel too, so the engine's per-channel controller state + SF2 2.01 default modulators apply (no duplicated DSP).
- `src/workstation/controller-events.ts` is shared by the worker, the offline WAV path (`midireader.tsx` export) and
  `midi-output.ts`, so realtime, WAV and MIDI out follow the same automation.
- **Seek / play-from / loop restore:** `controllerStateAt()` sends CC121 (reset; also releases sustain/sostenuto) per
  used channel, then the **mix base** layer (mixer CC7/10/11 defaults from `setMixBase`), then the last authored value
  per (channel, CC) (RPN/NRPN replayed in order), last bend / pressure.
- **Pause/stop/seek:** active notes are released per channel and CC64/CC66 are sent 0 so pedal-held voices never hang.

## Layers
1. Base defaults: mixer volume/pan/expression (per track, persisted in project mix).
2. Authored automation: timed CC events in the file/project; they win at their event times.
3. Temporary live overrides: moving a mixer knob during playback writes engine-wide CC7/10/11 immediately; it lasts until
   the next authored event for that CC, and never rewrites authored events. Seek/loop rebuilds from layers 1+2.

## CC66 / CC67 audit
The engine had these swapped (CC67 acted as sostenuto, CC66 as soft pedal). Fixed to MIDI 1.0: **CC66 sostenuto,
CC67 soft pedal**; `test/sf2-compliance-midi.test.ts` updated (MIDI-03/04) and `docs/SF2_COMPLIANCE.md` notes the fix.

## Timing (honest)
The worker ticks every 5 ms with a 30 ms lookahead and posts events **without timestamps**; the worklet applies them on
receipt (next 128-frame quantum). Events can therefore fire up to ~30 ms early and with ~3 ms block quantization
jitter; CCs share the notes' path so their relative timing to notes is preserved. Sample accuracy is **not** claimed
for realtime. Offline WAV uses frame-accurate `renderScheduled` with the same events.

## Audibility (SF2 engine)
Audible via default modulators/engine: CC1 (vibrato depth mod), 7, 10, 11, 64, 66, 67, pitch bend, channel/poly pressure.
CC71/74 are routed/stored but only audible if the preset defines modulators for them. CC91/93 are stored/exported
but **no reverb/chorus send processing exists**, so they are reported as inaudible.
