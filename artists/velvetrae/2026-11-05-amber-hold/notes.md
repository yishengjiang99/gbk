# Amber Hold — Velvet Rae
- Label `rnb` · quiet-storm / late-night neo-soul · 80 BPM 4/4, ~17% swung 16ths · Db major → D major (final chorus + outro) · 72 bars · ~3:40 incl. tail
- Lead: clean electric guitar (GM 27). Tracks: Guitar, Rhodes, finger bass, drums, skank guitar, warm pad, voice oohs, soft strings
- Master: -15.8 LUFS integrated, peak -1.4 dBFS, LRA 10.7 LU (fluidsynth + dual-pass loudnorm)
- Form: Intro 4 · Verse 8 · Pre 4 · Chorus 8 · Verse 2 8 · Pre 4 · Chorus 2 8 · Bridge 8 · Final Chorus 16 (+1 semitone) · Outro 4 (rit)
- Hook head (+2,+3,-1,-2) stated 5× in lead; inverted (-3,-2,+2,+3) 6× in verses. 0 chord-tone clashes. Drum ghosts 174.
- Build: `python3 generate.py 4` → `python3 render.py 4` (fluidsynth GeneralUser GS). Work dir `/workspace/vr7`.

## Final per-section LUFS
Intro -34.2 · V1 -17.4 · Pre -15.9 · Ch -15.5 · V2 -18.1 · Pre2 -17.0 · Ch2 -15.7 · Bridge -23.1 · Final -13.6 · Outro -31.8
Chorus 2 → Final +2.1 LU. Lead sits 4.0–7.3 dB over backing in choruses (500 Hz–4 kHz, raw no-lead subtract). 0 clipped samples.

## Revisions
- v1: 35 half-step clashes on the hook over changing chords. Lead buried in choruses (−1 dB). Flat dynamics (intro nearly as loud as chorus). No shaker/strings/builds yet.
- v2: Aggressive snap wiped the hook intervals (0 statements). `nolead` generate clobbered lead volume to 0 so full/nolead WAVs matched. Fixed snap to only half-step clashes; stopped nolead from rewriting n{REV}.json; boosted guitar fader; added shaker, rotating Rhodes/bass, pre snare builds, strings.
- v3: Softened intro Rhodes/pad. Fixed inverted verse head (Db–Bb–Ab–Bb–Db). Hook 5× / invert 7× / 0 clashes. Lead now +6 to +14 dB (a bit hot). Chorus2→Final only +0.9 LU. Integrated −14.5.
- v4 (final): Widened section energies; quieter Chorus 2, louder Final (+2.1 LU). Hard groove forced on all choruses. Dual-pass loudnorm → −15.8 LUFS / LRA 10.7. Lead 4.0–7.3 dB in choruses. Chorus drums restored.
