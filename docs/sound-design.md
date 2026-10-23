# Sound design: reverb / chorus, voice overrides, agent tools

## Effects (engine)
`src/sf2/effects.ts` (G-11, shared design with sf2player-swift): a Freeverb-style stereo reverb (8 lowpass-feedback
combs + 4 series allpasses per channel, 23-sample stereo spread, Float32 math) and a chorus (two quadrature-modulated
delay lines, linear interpolation). Both are deterministic and allocation-free, and run in the AudioWorklet
(`renderScheduled`) and in the offline WAV render (`renderRange`), so export sounds like playback.

**Send per voice.** Each voice's post-filter, post-pan output is mixed into the reverb bus at
`clamp(zone gen 16 + modulators → 16 + NRPN + override, 0, 1000) / 1000`, and into the chorus bus the same way
with gen 15. "Zone" means preset + instrument generators summed per SF2 9.4. The modulator sum includes the SF2
2.01 default modulators 8.4.8 / 8.4.9 (CC91 → reverb, CC93 → chorus; linear, unipolar, positive; amount 200, so
CC 127 adds 19.8 %). These two defaults are a GBK extension for files whose modulator list lacks them (2.04 files and
hand-built regions). A preset that defines its own CC91/93 modulator uses that one instead, never both. CC91/93 has
no separate shortcut to gain.

**Global parameters** (`Sf2SynthEngine.setEffectParams`, `{type:"setEffects"}` message, project `sound.effects`):
| param | range | default | mapping |
|---|---|---|---|
| enabled | bool | true | off switch (dry path) |
| roomSize | 0–1 | 0.5 | comb feedback 0.7 + 0.28·size |
| damping | 0–1 | 0.5 | comb damp 0.4·damping |
| reverbLevel | 0–1 | 0.5 | wet 0.7·level |
| chorusLevel | 0–1 | 0.7 | chorus wet |
| chorusDepthMs / chorusRateHz / chorusDelayMs | 0–10 / 0.05–5 / 1–30 | 4 / 0.6 / 12 | depth is kept below the delay |

The defaults are exactly the previous fixed values. Each app track has its own worklet engine with its own effects
instance. Because the effects are linear, this sums to the same signal as the single shared instance used in the
offline render.

## Voice overrides
`src/sf2/voice-overrides.ts`. A `VoiceOverride` is `{gen, mode: "add"|"set", value (native SF2 units), keyLo?, keyHi?}`
for an editable generator: vol/mod envelope delay/attack/hold/decay/sustain/release, keynum→hold/decay, modEnv→pitch/filter,
filter cutoff/Q, mod LFO delay/freq/→pitch/→filter/→volume, vibrato delay/freq/depth, coarse/fine/scale tuning, pan,
attenuation, and the reverb/chorus sends. `set` replaces the zone value and `add` offsets it. Modulators still apply
on top, and the result is clamped to the §8.1.3 range.

Engine: `setVoiceOverrides(trackIndex, list, updateActive)` (`trackIndex -1` = every voice of this engine; the
worklet uses that). Deltas are computed at note-on into a per-voice preallocated array and are added with the NRPN
and modulator sums. With `updateActive`, realtime generators (filter, pitch depths, pan, attenuation, sends) update on
sounding voices too. Envelope times and LFO rates are note-on only, which is SF2 semantics.

Workstation: `Project.sound = { tracks: {trackId: VoiceOverride[]}, effects }` (optional, older projects load
unchanged). Ops `setVoicePatch` (merge/replace) and `setEffects` are validated, undoable, autosaved to IndexedDB, and
also used by the **Sound panel** (right column: ADSR graph, sliders for envelope, filter, LFO, vibrato and sends,
effects sliders, and a dashed "B" envelope plus diff list for a focused sound proposal). The player bridge pushes the
committed sound layer to the engines (or the candidate's layer during an A/B "B" preview) and into the offline render.

**MIDI export.** `add` overrides without a key range export as SF2 NRPNs (§9.6: CC99=120, CC98=gen, CC38/CC6 14-bit
offset scaled per §9.6.3) at tick 0 on the track's channels, and GBK and other SF2 2.01 NRPN-aware synths replay them.
`set` overrides, key-ranged overrides, scaleTuning (not NRPN-able) and the effects parameters are **project-only**.
GS/XG NRPNs are not emitted (their semantics differ per synth). On re-import, the NRPNs come back as ordinary CC events.

## Swift parity
sf2player-swift implements the same effects (`SF2Effects.swift`) but **not** effects parameters, voice overrides or
the CC91/93 default modulators for 2.04 files. The parity renderer (`src/sf2/parity.ts`) therefore sets
`sendCcModulators = false`, and parity scenarios never use overrides or non-default effect parameters. gbk↔Swift
bit-exactness is unchanged. Porting these features to Swift is future work.

## Tests
`test/sound-design.test.ts`: send rules (gen16=0/CC91=0 → no wet; gen16=500 → 50 % bus; CC91=127 adds ≈20 %;
overrides add, set and clamp; explicit file CC91 modulator not doubled), audible deterministic reverb tail, roomSize
lengthens it, envelope overrides change the measured attack/release times, key-range and per-track scoping, unit
conversion, NRPN bytes reproduce the offset in the engine.
`test/sound-tools.test.ts`: tool validation, proposal → commit → undo/redo, persistence round-trip, MIDI NRPN
export/re-import, and the engine rendering exactly the send `gbk_get_voice_settings` reports.
`test/e2e/workstation-voice.spec.ts` (chrome-webmcp): an agent proposes a longer release plus more reverb, runs A/B,
the user accepts, two WAV exports differ, the tail energy rises, then undo and reload persistence are checked.


## Offline render fidelity

The headless renderer (`src/audio/offline-renderer.ts`) drives the same `Sf2SynthEngine` as the live player and
honours programs/banks (channel 10 → bank 128), CC7/10/11/1/64/91/93, pitch bend, voice overrides and project
effects, the full tempo map and a configurable release tail. Missing presets fall back to bank 0 with a warning
(`INSTRUMENT_NOT_FOUND` if nothing matches). Per-track player preset overrides and
orchestral auto-pan are applied (see below).

### Reverb/chorus level, loudness and live parity (offline + live)

- **Reverb return.** `SF2Effects` follows Freeverb/FluidSynth: combs are fed the mono send (sum of the panned send
  buses) times 0.03, and the wet return defaults to FluidSynth's 2.7 (`reverbLevel` 0.5; 1.0 = 5.4). Previously the
  return was 0.35 on half the input, about 24 dB quieter, so CC91 and gen16 sends could not be heard. This applies to
  live playback and offline renders alike (same engine).
- **Topology parity.** Offline renders use one engine per audible track (own reverb/chorus and master stage), then
  the StereoPannerNode law (orchestra auto-pan is opt-in, `autoPan:true`, and only seats tracks without an explicit
  pan: a non-centre mix pan or CC10 automation), then a sum, which is exactly the
  live per-track AudioWorklet graph. Player-pinned per-track presets are applied and pin the track (program changes
  ignored), as in the player.
- **Loudness.** Default `normalize: "loudness"`: BS.1770-4 integrated loudness (K-weighting, gated) to **-16 LUFS**,
  capped at **-1 dBTP** true peak (4x oversampled). It is one gain for the whole file and never per section, so CC
  and velocity dynamics are unchanged. `"peak"` sets the true peak to -1 dBTP; `"off"` gives the raw engine output.
  The result's `loudness` field reports input/output LUFS, true peak, the gain and which limit applied.
- **Tail.** `tailSeconds` (default 3) follows the last note-off, so releases and the reverb tail are rendered and
  decay inside it. Renders are deterministic: identical input gives an identical SHA-256.

### Track volume, master volume and preset parity

- **Track volume** (workstation slider / `gbk_set_track_mix volume`) is a fader: a post-engine gain of
  `(volume/100)^2` (the SF2 CC7 square law; 100 = 0 dB, 50 = -12 dB). It applies live (track gain node) and offline,
  and works on top of authored CC7 automation. Before, it was only a CC7 base value, so any CC7 event in the song
  replaced it. The render report lists `volume` and `faderDb` per track.
- **Master volume** is the live monitor level (engine `masterGainDb`) and is not baked into renders. Note that the
  default `normalize: "loudness"` sets the whole file to -16 LUFS, so changing every track's volume together
  does not change the file's loudness; relative balance does change. Use `normalize: "off"` to hear absolute levels.
- **Preset parity.** `gbk_get_voice_settings`, `gbk_list_presets` and the Sound panel resolve presets with the
  renderer's SoundFont and bank/program mapping (`resolveTrackPreset`, loaded on demand), not the player's slots.
