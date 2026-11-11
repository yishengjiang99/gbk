# Saffron Ferry (Juniper Blue): Afro-Cuban 6/8 jazz, G minor, dotted quarter 100 (quarter 150), about 186s
- Flute (GM73) lead, Muted Trumpet (GM59) octave below in A, diatonic harmony in A2, fourth below in B; backgrounds behind the flute and piano solos.
- Piano (GM0) montuno, latin octaves in its solo. Acoustic Bass (GM32) Afro 6/8 with anticipations. Kit: 12/8 bell (cowbell head, ride bell solos), congas, shaker, hat foot, rim.
- Form (152 bars of 6/8): Intro Gm9 vamp 8 | Head AABA 56 | Flute solo AA 32 | Piano solo AB 24 | Head out B A 24 | Coda 8.
- A: Gm9 x4, Ebmaj7#11 x2, D7alt x2, Gm9 x4, Abmaj7#11 x2, D7alt x2. B: Cm9 x2, F13 x2, Bbmaj7, Ebmaj7, Am7b5, D7alt.

## Revisions
- v1: left-heavy (L/R 1.25), piano solo 3 dB under the head and bass-dominated.
- v2: pans recentred (L/R 0.94). Piano solo still thin.
- v3: piano solo in octaves, trumpet pads under its B section.
- v4/v5: piano track up, comping eased elsewhere, intro lifted.
- v5 (published): peak -3.1 dBFS, 0 clipped, RMS -18.3. Heads -17 to -18, piano solo -20.9 (deliberate breakdown), intro -24.

## Reproduce
`python3 compose.py 5 "$(cat arc_v5.json)"`, then
`MIX='[["Flute","flute",0,73,104,66],["Muted Trumpet","trumpet",1,59,84,76],["Acoustic Grand Piano","piano",2,0,114,58],["Acoustic Bass","bass",3,32,100,64],["Kit and Congas","drums",9,0,90,68]]' node render.mjs 5`
(playwright from /workspace/gbk-pw/node_modules). `python3 an.py <wav> plan_v5.json` analyses.
