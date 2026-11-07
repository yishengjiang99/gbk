# Copper Softly — Velvet Rae
- Label `rnb` · after-hours neo-soul / quiet R&B · 72 BPM 4/4, ~18% swung 16ths · C# minor (dorian) → E major (final chorus + outro) · 72 bars · ~4:03 incl. tail
- Lead: muted trumpet (GM 59). Tracks: Trumpet, Rhodes, finger bass, drums, skank guitar, warm pad, voice oohs, soft strings
- Master: -16.0 LUFS integrated, peak -1.5 dBFS, LRA 11.8 LU (fluidsynth + dual-pass loudnorm)
- Form: Intro 4 · Verse 8 · Pre 4 · Chorus 8 · Verse 2 8 · Pre 4 · Chorus 2 8 · Bridge 8 · Final Chorus 16 (to E major) · Outro 4 (rit)
- Hook head (+3,+2,−1/−2) stated 12× in lead; inverted (−3,−2,+2,+3) 3× in verses. 0 chord-tone clashes. Drum ghosts 183.
- Build: `python3 generate.py 5` → `python3 render.py 5` (fluidsynth GeneralUser GS). Work dir `/workspace/vr8`.

## Final per-section LUFS
Intro -35.5 · V1 -18.3 · Pre -15.3 · Ch -14.8 · V2 -19.8 · Pre2 -17.7 · Ch2 -16.0 · Bridge -23.8 · Final -13.6 · Outro -31.8
Chorus 2 → Final +2.4 LU. Lead sits 6.5–9.2 dB over backing in choruses (500 Hz–4 kHz, raw no-lead subtract). 0 clipped samples.

## Revisions
- v1: Hook only 2× (Final transpose snapped off Emaj9). Lead buried in choruses (−0.2 to −4 dB). Flat arrangement (no shaker/builds).
- v2: REV≥2 groove/builds/strings. Lead clearer in Ch1 (+5.7) but Ch2/Final still thin. Hook still 2×; verse invert snapped (G natural).
- v3: Chord-safe hook restatements (12×) + verse invert (−3,−2,+2,+3). 0 clashes. Ch2→Final +2.7 LU. Lead still thin in Ch2/Final (+1.8/+2.2).
- v4: Widened energies, quieter skank in Final, harder chorus groove. Lead still thin (muted trumpet quiet in SF2).
- v5 (final): Trumpet fader/vel up; Rhodes/oohs/strings/drums cut. Lead 6.5–9.2 dB in choruses. Dual-pass loudnorm → −16.0 LUFS / LRA 11.8.
