# 2026-11-27 Juniper Blue: three drafts

## d1 Lantern Orchard: jazz waltz, A major, 168 BPM in 3, flute, piano, bass, brushes (sticks in the flute solo). 172 bars, 185 s.
- Hook & melody: 64-bar AABA with a clear hook (held maj7 G#, step up to C#). Bars 5-6 restate the bars 1-2 rhythm a fourth higher. Bridge answers with long lydian tones.
- Harmony: B7 to Bm7 chromatic slide; second A turns iv-minor (Dm6, G7#11) before coming home; bridge goes to the bVI lydian (Fmaj7#11). Freshest changes of the three.
- Structure: intro vamp, head, flute solo (A A), piano solo (B A), head out from the bridge, coda. Good arc.
- Groove: bass in one under the first two As, walking from the bridge. Waltz ride (1, 2, 2&, 3) swings.
- Mix (stems, unnormalised): flute -28.0, piano -46.7, bass -46.3, drums -45.7 dB. Flute 18 dB over the band (hot patch). Leans left, L/R 1.29 (flute pan 60). Generated solos sat low (B4-E5) and sparse.
- Fit: lyrical, Evans-style waltz. New meter and lead for the catalogue.

## d2 Pale Meridian: ECM chamber jazz, B minor / lydian colours, 100 BPM straight, soprano sax, cello, piano ostinato, bass, mallets and cymbals. 94 bars, 228 s.
- Hook & melody: mostly long tones. Atmospheric, but the hook is thin.
- Harmony: static modal colours. The bridge (G, F, Eb lydian planing) is the best part.
- Structure: the ostinato barely changes over 94 bars, so it drags.
- Groove: generated bebop lines in the solos fight the ECM mood.
- Mix: sop -39.5, cello -40.0, piano -47.9, bass -48.1, drums -52.0 dB. Drums buried; cello L/R 1.51, drums L/R 1.93; whole mix leans left (1.25-1.30).
- Fit: furthest from Juniper Blue's swing identity.

## d3 Mulberry Porch: slow blues in G, 66 BPM triplet swing, clarinet, piano, bass, brushes. 67 bars, 246 s.
- Hook & melody: real blues head with blue notes and triplet turns. Head is played twice unchanged.
- Harmony: jazz blues (Dm7 G7alt, C#dim7, Bm7b5 E7alt), tritone tag. Solid but generic.
- Structure: five choruses in 4 min. Long for the material.
- Groove: generated eighth-note solo lines feel stiff at 66 BPM.
- Mix: cl -39.1, piano -47.6, bass -48.5, drums -45.7 dB. Lead 8 dB over the band; balanced L/R.
- Fit: fine, but the least distinctive.

## Pick: d1 Lantern Orchard
Best tune and changes, and a jazz waltz is new for the catalogue. Its problems (lead level, low solos) were fixable.

## Revision (v2, v3 published), `d1r.py`
- Mix: flute vol 112 -> 46 and pan 60 -> 64, piano pan 64 -> 62, piano solo velocity x1.12.
- Writing: flute solo opens with a 4-bar development of the hook and closes with a written 2-bar cadence. Piano solo opens with a 4-bar bridge-derived phrase. Generated lines moved up (flute D5-A6, piano G4-G6) and made denser. Bass roots raised (lo 33) so the two-feel isn't muddy.
- v2 stems, unnormalised: flute -43.3, piano -46.5, bass -46.4, drums -45.7 dB.
- v3 sections: -17.2 to -18.9 dB (intro -22.2), L/R 0.89-1.07, peak -1.8 dBFS, 0 clipped.

## Reproduce
`python3 d1r.py d1v3` then `node render.mjs d1v3` (playwright from /workspace/gbk-pw/node_modules). Stems: `python3 stems.py d1v3`, `NORM=none bash q.sh d1v3S<track>...`, `python3 stemlev.py d1v3`. Melody check: `python3 d1.py lint`, `python3 d1r.py lint2`. 3/4 engine: `waltz.py`.
