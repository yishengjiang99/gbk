# Slate Harbor Waltz (Juniper Blue): modal jazz waltz, D dorian, 3/4, 150 BPM, about 98s
- Quintet: Vibraphone (GM11, lead), Trumpet (GM56, B head and solo), Piano (GM0, rootless voicings, five rotating waltz comp patterns), Upright Bass (GM32, two-feel in heads, walking with chromatic approach notes in solos), Drums (waltz ride 1, 2, 2&, 3; hat on 2; feathered kick; cross-stick on 3 in heads).
- Form (80 bars): Intro 4 | Head A 16 | Head B 8 | Vibes solo 16 | Trumpet solo 16 | Head out A 16 | Coda 4.
- The head melody is written by hand and original. The solos are written lines: chord tones on the strong eighths, scale steps between, 4-bar phrases ending on a held 3rd or 7th.

## v1 (muted trumpet GM59)
- 98.3s, peak -1.72 dBFS, 0 clipped. Section RMS: intro -21.2 | A -17.2 | B -20.9 | vibes solo -16.8 | trumpet solo -20.0 | head out -17.2 | coda -18.5.
- Problem: the muted trumpet vanished (1-4 kHz presence -21 to -24 dB in its sections; bass dominated).

## v2
- Trumpet velocity and volume up, bass and piano eased under it. Trumpet presence up to -14/-16 dB, but its sections were still 5 dB under the vibes sections.

## v3
- Switched to open trumpet (GM56). Presence -4.7/-6.3 dB, but the trumpet solo sat 3.5 dB under the vibes solo.

## v4 (published)
- Vibes comp soft shell chords under the B head and the trumpet solo; the trumpet solo section lifted 5%.
- 98.3s, peak -2.16 dBFS, 0 clipped, RMS -18.5 dBFS. Section RMS: intro -21.0 | A -18.3 | B -20.7 | vibes solo -17.5 | trumpet solo -18.1 | head out -17.9 | coda -20.3. Stereo L/R 0.68 to 1.24.

## Reproduce
`python3 compose.py 4 '{"Intro":1.08,"bass@Head B":0.88,"piano@Trumpet solo":0.9,"piano@Head B":0.9,"Trumpet solo":1.05,"Coda":0.92}'`, then `MIX='[["Vibraphone","vibes",0,11,100,76],["Trumpet","trumpet",1,56,110,52],["Piano","piano",2,0,90,58],["Upright Bass","bass",3,32,104,64],["Drums","drums",9,0,80,62]]' node render.mjs 4` (needs /workspace/juniper/lib.mjs with playwright). `python3 an.py <wav> plan_v4.json` analyses; `build_project.py` writes project.gbk.json.
