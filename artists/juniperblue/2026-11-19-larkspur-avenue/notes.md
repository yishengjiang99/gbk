# Larkspur Avenue (Juniper Blue)
Original medium swing, Bb major, 120 BPM, about 214 s.
- Trombone (GM57) lead, vibraphone (GM11) harmony and solo, piano rootless comping, upright bass, drums (brushes in two-feel, then ride).
- Form (105 bars): Intro 8 (two-feel) | Head ABAC 32 (A1 two-feel, then walking) | Trombone solo 32 | Vibes solo 16 | Head out A + C with Bb6 ending.
- A: Bbmaj7 | Bbm7 Eb7 | Abmaj7 | Am7b5 D7alt | Gm7 | C7#11 | Cm7 | F7.
- B: Dm7 | G7alt | Cm7 | Cm7 | Ebm7 | Ab7 | Dm7 G7 | Cm7 F7.  C: Ebmaj7 | Ab7#11 | Dm7 | G7alt | Cm7 | F7 | Bb6 | Cm7 F7.

## Drafts (all rendered and compared)
- d1 Coalyard Blues: G minor blues, tenor + trio, 138 BPM. Strong riff hook, but conventional changes and 72 of 128 bars are generated solos.
- d2 Larkspur Avenue: ABAC, trombone + vibes. Richest harmony (Abmaj7 shift, C7#11, Ab7#11), lyrical written head with vibes harmony, two-feel to walking arc. Won.
- d3 Marigold Sprint: D major piano trio, 160 BPM. Catchy sequence hook and block-chord bridge, but long (262 s) and the drum trades sound aimless.

## Revisions of d2
- v2: longer, arched solo phrases (engine fix shared by all drafts).
- v3: stems measured unnormalised: bass was 4.5 dB over the lead, vibes over the trombone, drums ~16 dB under. Bass vol 90->55, vibes 88->62, drums 82->110, piano 86->92; soft vibes shells added under head A1.
- v4 (published): intro +20%, pans narrowed (trombone 62, vibes 67). Peak -2.2 dBFS, 0 clipped, L/R 0.89-1.06.

## Reproduce
`python3 d2.py d2v4 "$(cat arc_v4.json)"` then `node render.mjs d2v4` (playwright from /workspace/gbk-pw/node_modules). `python3 an.py <wav> plan_d2v4.json` analyses.
