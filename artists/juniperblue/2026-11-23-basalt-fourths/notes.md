# Basalt Fourths (Juniper Blue)
Original modal post-bop, F dorian, 144 BPM, about 184 s. Tenor sax (GM66), piano with quartal voicings, upright bass, ride kit.
- Form (108 bars): Intro 8 (bass pedal, piano teases the fourths motif) | Head AABA 32 | Tenor solo 32 | Piano solo 16 | Head out B + A | Coda 4.
- A: Fm9 x4 | Dbmaj7#11 x2 | Ebm9 | C7alt (bass pedal on the Fm9 bars of A1, A2, A3, out A).
- B: Abm9 x2 | Emaj7#11 x2 | Am9 x2 | Bbm9 | C7alt (planing modal sequence).

## Drafts (all rendered, stems measured)
- d1 Basalt Fourths: modal post-bop, F dorian, 144, tenor quartet. Memorable rising-fourths hook, freshest harmony (planing bridge), quartal piano new for Juniper. Head sat in tenor altissimo (C5-C6); tenor 5 dB under bass. Won.
- d2 Lamplighter's Blues: slow minor blues, C minor, 66, 12/8 feel, guitar/piano/bass/brushes. Idiomatic riff but generic form, 296 s too long, eighth-note engine solo plods at 66, guitar 7 dB over the band and leaning left.
- d3 Guava Lantern: charanga cha-cha, F, 116, flute/violins/montuno/tumbao/percussion. Catchy head, but every odd bar repeats one rhythm, percussion stack busy, flute 11-17 dB over everything.

## Revisions of d1
- v2: head down an octave (tenor's home register), lead +8 velocity, tenor vol 127, bass vol 48, solo ceiling up 2. Tenor -48.7 -> -43.8 dB.
- v3 (published): piano plays the fourths motif in intro bars 5-8, piano solo +8 velocity, pans recentred (tenor 64, piano 58). Stems unnormalised: tenor -43.7, piano -45.6, bass -47.0, drums -46.0 dB. Peak -1.0 dBFS, 0 clipped, L/R 1.01-1.10.

## Reproduce
`python3 d1.py d1v3` then `node render.mjs d1v3` (playwright from /workspace/gbk-pw/node_modules). Stems: `python3 stems.py d1v3`, `NORM=none bash q.sh d1v3S<track>...`, `python3 stemlev.py d1v3`.
