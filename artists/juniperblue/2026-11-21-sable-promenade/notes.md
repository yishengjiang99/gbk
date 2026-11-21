# Sable Promenade (Juniper Blue)
Original Ellington-style mid-tempo swing, Db major, 112 BPM, about 235 s.
- Trumpet (GM56) lead, clarinet (GM71) harmony and bridge lead, trombone (GM57) guide tones, piano, upright bass, drums (brushes in intro and head, then ride).
- Form (108 bars): Piano intro 8 | Head AABA 32 (clarinet takes the bridge) | Trumpet solo 32 (horn backgrounds on B and last A) | Clarinet solo 16 (trumpet/trombone backgrounds on 2nd A) | Head out B + A | Tag 4.
- A: Db6 | Db7 | Gbmaj7 | Gbm6 | Fm7 | Bb7alt | Ebm7 | Ab7 (A2 ends Ebm7 Ab7 | Db6).
- B: F#m7 B7 | Emaj7 | Em7 A7 | Dmaj7 | Dm7 G7 | Cmaj7 | Ebm7 | Ab7alt (sequence down by whole steps).

## Drafts (all rendered, stems measured)
- d1 Chicory Second Line: New Orleans second line, F, 104 BPM, trumpet/clarinet/trombone/tuba/banjo. Catchy riff head, but the clarinet obbligato is bebop-ish noodling, not trad, and drums sat ~5 dB over the lead.
- d2 Quarry Lights: Rhodes jazz-funk boogaloo, G dorian, 100 BPM, trumpet+tenor unison. Good riff and Bbm7-Eb7-Abmaj7 twist, but generic programmed groove, swing-engine solos sound out of idiom, tenor 10 dB under, bass-heavy.
- d3 Sable Promenade: Ellington mid-tempo, Db. Richest harmony, voiced horns, clarinet bridge with a sequence. Won.

## Revisions of d3
- v2: lead +10 velocity, backgrounds under solos, mix rebalanced. Muted trumpet (GM59) still buried and very buzzy (22% of energy above 4 kHz).
- engine: solo lines now commit to a direction after hitting the peak or floor (no more 2-note oscillation at the top).
- v3a/v3b: muted vs open trumpet A/B. Open trumpet clean (air -17 dB vs -9). Chose open.
- v4: trumpet vol 88, others trimmed; pans trumpet 63, clarinet 68, trombone 60.
- v5 (published): intro piano/clarinet +25%/+15% velocity. Stems unnormalised: trumpet -43.0, clarinet -47.4, trombone -47.3, piano -46.5, bass -46.5, drums -47.0 dB. Peak -2.9 dBFS, 0 clipped, L/R 0.98-1.07.

## Reproduce
`python3 d3.py d3v5 "$(cat arc_v5.json)"` then `node render.mjs d3v5` (playwright from /workspace/gbk-pw/node_modules). Stems: `python3 stems.py d3v5` then `NORM=none bash q.sh d3v5S<track>...`, `python3 stemlev.py d3v5`.
