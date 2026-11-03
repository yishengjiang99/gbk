# Sugar in the Static — Velvet Rae
- Label `rnb` · Dilla-feel neo-soul · 86 BPM 4/4, drunk 16th swing · E minor (dorian) → G minor (final chorus + outro) · 72 bars · 3:25 incl. tail
- Master: -16.2 LUFS integrated, peak -1.2 dBFS, LRA 9.7 LU (render +5.5 dB into a gentle limiter)
- Form: Intro 4 · Verse 8 · Pre 4 · Chorus 8 · Verse 2 8 · Pre 4 · Chorus 2 8 · Bridge 8 · Final Chorus 16 (+3 semitones) · Outro 4 (ritardando)
- Tracks: chromatic harmonica lead (centre), Rhodes, finger bass, drums, clean guitar, muted-guitar scratch, voice oohs, strings
- Build: `python3 generate.py 5` writes v5.json, then `npm run song:publish -- v5.json --date 2026-11-03` (needs `GBK_BASE_PATH=/gbk/`).

## Final per-section LUFS (pre-master)
Intro -31.4 · V1 -26.4 · Pre -23.9 · Ch -20.3 · V2 -24.1 · Pre2 -22.9 · Ch2 -19.4 · Bridge -26.9 · Final -17.8 · Outro -33.9
Hook head (+3,+2,-2,-3) found 5× in the lead, inverted 2× in the verses. 0 clipped samples. Lead sits 4–9 dB over the backing (500 Hz–4 kHz, from a no-lead render).

## Revisions
- v1: The 90–250 Hz band was the loudest band (Rhodes left hand doubled the bass, voicings started at E3). The lead was only 1.5–2.7 dB over the backing in the choruses, where 16th scratch guitar crowded it.
  Rhodes and bass played the same rhythm every bar. The pre-chorus barely built. Chorus 2 → final was only +1.1 LU.
- v2: Rhodes voicings moved up a third and the left-hand doubling was dropped. Bass got quieter, and the scratch guitar got quieter and sparser. Lead +14 on the fader, louder in choruses, softer in the bridge (lead now 4.5–6.4 dB over the backing).
  Four rotating Rhodes and bass rhythms. Stop-time snare build on the last pre-chorus bar. Strings swell in pre-chorus 2. Shaker from verse 2 on, tambourine and a Rhodes top-octave double in the final chorus.
  The intro was still quiet with no groove, the bridge never built back, and chorus 2 → final was +1.2 LU.
- v3: Soft hats from bar 1. The bridge's last bar is a 16th snare build. The final chorus gets an extra kick, open hats every bar, and louder oohs and strings. Verse bass is lighter, and the bridge and outro lead are softer. Chorus 2 → final is now +1.8 LU.
- v4: Harmony. Chorus bar 2 is now B7b9#9, so the hook's C–D passing tones are chord tones. The final chorus's second half reharmonizes the hook (Cm11, Ab13#11, Abmaj9–Db13). Quiet strings bed under the intro.
- v5 (final): Intro energy raised (-32.8 → -31.4 LUFS).
