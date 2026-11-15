# Tinsmith Wheel (Juniper Blue): gypsy jazz (manouche) swing, D minor, 200 BPM, about 174s
- Violin (GM40) lead, steel lead guitar (GM25) intro lick, bridge fills and octave doubling on the head out.
- Rhythm guitar (GM24) la pompe: low boom on 1/3, chick on 2/4. Upright bass two-feel in heads, walking in solos. Light brushes.
- Form (143 bars): Intro 8 | Head AABA 32 | Guitar solo 32 | Violin solo 32 | Head out AABA 32 | Coda 7.
- A: Dm6 x2, Gm6, Gm6/C#dim, Dm6, Bb7, Em7b5/A7b9, Dm6/A7b9. B: D7 x2, Gm6 x2, Bb7, A7b9, Dm6/Bm7b5, Em7b5/A7b9.

## Revisions
- v1-v4 (11/13): balance passes on the solos and intro; v4 was bass-heavy (about 75% of energy under 200 Hz) with leads buried.
- v5: bass 90 to 74, kick softened, violin and lead guitar up. Leads now present, guitar solo leaned right (L/R 0.90).
- v6 (published): pans recentred. Peak -2.5 dBFS, 0 clipped, RMS -18.9.

## Reproduce
`python3 compose.py 6 "$(cat arc_v4.json)"`, then
`MIX='[["Violin","violin",0,40,108,62],["Lead Guitar","guitar",1,25,116,67],["Rhythm Guitar","rhythm",2,24,82,58],["Upright Bass","bass",3,32,74,64],["Brushes","drums",9,0,72,62]]' node render.mjs 6`
(playwright from /workspace/gbk-pw/node_modules). `python3 an.py <wav> plan_v6.json` analyses.
