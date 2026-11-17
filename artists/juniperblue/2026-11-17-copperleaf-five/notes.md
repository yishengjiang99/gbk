# Copperleaf Five (Juniper Blue): cool jazz in 5/4, E minor, 168 BPM, about 199s
- Alto sax (GM65) lead, piano (GM0) rootless voicings comping 3+2, upright bass (GM32), ride kit.
- Form (110 bars): Intro vamp 8 | Head AABA 32 | Alto solo 32 | Piano solo 16 | Head out BA 16 | Coda 6.
- A: Em9 x2, Cmaj7 x2, Am9, D9, Gmaj7/F#m7b5, B7alt. B: Fmaj7#11 x2, Em9 x2, Dm9/G13, Cmaj7, F#m7b5, B7b9.
- Bass: 3+2 ostinato in intro/head/coda, walking quarters in solos and head out.

## Revisions
- v1: piano solo too quiet (-19.8 dB RMS, presence -16 dB), intro bass-heavy.
- v2: piano solo up, bass down in intro and solo; mix still leaned left.
- v3 (published): piano solo up again, pans recentred (L/R 0.97-0.98). Peak -2.4 dBFS, 0 clipped, RMS -18.7.

## Reproduce
`python3 compose.py 3 "$(cat arc_v3.json)"`, then
`MIX='[["Alto Sax","alto",0,65,104,66],["Piano","piano",1,0,96,61],["Upright Bass","bass",2,32,80,64],["Drums","drums",9,0,80,64]]' node render.mjs 3`
(playwright from /workspace/gbk-pw/node_modules). `python3 an.py <wav> plan_v3.json` analyses.
