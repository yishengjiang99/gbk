# SF2Player (vendored)

Copied from earsheet `Packages/SF2Player` @ 357cb76895f912ebe1809399421b508bd94353d8 (Yisheng Jiang, AGPL-3.0-or-later):
SMF reader, sequencer, lock-free real-time core and the AVAudioEngine `SF2MIDIPlayer`, on top of
SF2Engine (github.com/yishengjiang99/sf2player-swift @ 6ce4941).

Local changes for the gbk feed:
- `SF2MIDIPlayer.engine` is public (feed installs its spectrum/waveform tap on the output and fades the mixer).
- `SF2MIDIPlayer.managesAudioSession` (default true): the gbk app sets it false so `AudioSessionController` stays the single session owner.
- `SF2MIDIPlayer.outputGainDb` / `fadeGain`: main-mixer gain (crossfades).
- `SF2RealtimeCore.setMasterGainDb` / `setMasterDynamicsEnabled` (+ `SF2MIDIPlayer` wrappers): real-time-safe master gain and compressor/limiter switch; the feed runs a fixed 0.8 gain with dynamics off, like web live playback.
- `SF2MIDIPlayer.init(soundFont:)` shares one parsed bank across players.
Tests were not copied (they live in earsheet).
