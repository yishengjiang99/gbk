# Ember Hour (Juniper Blue): jazz ballad, Ab major, 66 BPM, about 177s
- Quartet: Alto Sax (GM65, lead), Piano (GM0, rootless voicings, fills at phrase ends), Upright Bass (GM32, half notes in heads, walking in solos), Brushes (GM brush kit, ch10 program 40: swirl 40 on beats, tap 38 and hat 44 on 2 and 4, ride under solos).
- Form (48 bars): Intro 4 | Head A 8 | Head B 8 | Piano solo 8 (A changes) | Alto solo 8 (B changes) | Head out A 8 | Coda 4.
- Harmony: ii-V chains, tritone subs (B7 for F7, A7 for Eb7), backdoor Gb7, bridge ii-V to Bmaj7.
- The head melody is written by hand and original. Solos are written lines: chord tones on strong eighths, scale steps between, phrase ends on held 3rds/7ths; the alto solo adds double-time sixteenth runs.

## v1
- 177.5s, peak -1.60 dBFS, 0 clipped. Section RMS: intro -25.8 | A -18.5 | B -18.5 | piano solo -20.6 | alto solo -17.8 | head out -18.7 | coda -21.1.
- Problem: the piano solo was buried (1-4 kHz presence -21.4 dB, low end dominant).

## v2
- Piano solo doubled in octaves, +14 velocity, double-time runs; bass and brushes eased under it; piano fills in the heads; intro lifted.
- Piano solo presence up to -11.5 dB, but the intro presence stayed low (-18.4).

## v3
- Bass eased in the intro, intro piano lifted, piano fader 92 to 100, alto 104 to 100, bass 100 to 96.
- Intro presence -13.7, piano solo presence -8.8.

## v4 (published)
- Full LH voicings and a stronger octave double in the piano solo.
- 177.5s, peak -1.80 dBFS (MP3 -2.0), 0 clipped, RMS -19.3 dBFS. Section RMS: intro -24.5 | A -18.5 | B -18.5 | piano solo -22.3 | alto solo -17.4 (peak) | head out -18.8 | coda -20.4. Alto presence (1-4 kHz) -5 to -6.5 dB in its sections.

## Reproduce
`python3 compose.py 4 '{"Intro":1.2,"bass@Intro":0.7,"piano@Intro":1.15,"bass@Piano solo":0.72,"drums@Piano solo":0.8,"piano@Piano solo":1.14,"Coda":1.05}'`, then `MIX='[["Alto Sax","alto",0,65,100,72],["Piano","piano",1,0,100,50],["Upright Bass","bass",2,32,96,62],["Brushes","drums",9,40,84,60]]' node render.mjs 4` (needs /workspace/juniper/lib.mjs with playwright in /workspace/juniper/.pw). `python3 an.py <wav> plan_v4.json` analyses; `build_project.py` writes project.gbk.json.
