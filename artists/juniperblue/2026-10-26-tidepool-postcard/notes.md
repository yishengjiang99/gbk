# Tidepool Postcard (Juniper Blue): bossa nova, F major, 140 BPM, about 112s
- Quintet: Flute (GM73, lead), Nylon Guitar (GM24, 2-bar bossa comp with anticipations, rootless-ish 4-note voicings), Piano (GM0, sustained 3rd/7th shells, then the solo), Acoustic Bass (GM32, root-fifth dotted-quarter + eighth), Drums (cross-stick bossa clave, closed-hat eighths, soft kick; ride under the flute solo).
- Form (64 bars): Intro 4 | Head A 8 | Head B 8 | Head A' 8 | Flute solo 16 (A+B changes) | Piano solo 8 | Head out A' 8 | Coda 4 (Gm7 C7 Dbmaj7 F6).
- The head melody is written by hand and original. The solos are written lines built from chord tones on the strong eighths and scale steps between them, in 4-bar phrases that end on held 3rds/7ths.
- The renderer applies loudness normalisation (target -16 LUFS, true-peak ceiling -1 dBTP), so section levels are compared relative to each other.

## v1 (all tracks centred, flat velocities)
- 111.7s, peak -3.42 dBFS, 0 clipped, RMS -18.3 dBFS.
- Section RMS: intro -21.1 | A -17.5 | B -17.3 | A' -17.8 | flute solo -18.1 | piano solo -21.1 | head out -17.9 | coda -17.1.
- Problems: the solo wasn't louder than the head, the coda was the loudest section, the mix was mono (L/R 1.00), and the piano solo was buried (1-4 kHz band at -21.7 dB, with the bass dominating).

## v2
- Changes: per-section velocity arc, a build through the flute solo (+10 velocity across 16 bars), ride cymbal under the flute solo, snare pickups into each section, stereo mix (flute right 76, guitar left 44, piano right 82), quieter head piano pads, hotter piano-solo notes, bass eased under the piano solo, coda tapered.
- 111.7s, peak -1.00 dBFS, 0 clipped. Section RMS: intro -29.0 | A -20.3 | B -19.2 | A' -19.4 | flute solo -17.4 (peak) | piano solo -25.0 | head out -19.1 | coda -21.3.
- Result: the arc and the stereo image now work, but the intro was too quiet and the piano solo was still a hole (7.6 dB under the flute solo).

## v3 (published)
- Changes: the piano solo is doubled in octaves (bossa piano style), it's denser (0.82), its velocity is up to 104, and the piano track volume is raised to 112. The intro is lifted.
- 111.7s, peak -1.00 dBFS (MP3 -1.3 dB), 0 clipped, RMS -19.4 dBFS.
- Section RMS: intro -25.9 | A -20.2 | B -19.1 | A' -19.4 | flute solo -17.3 (peak) | piano solo -23.2 (quieter interlude, but piano presence is up from -18.2 to -9.6 dB in the 1-4 kHz band) | head out -19.0 | coda -21.3.

## Reproduce
`python3 compose.py 3` writes plan_v3.json and the .mid. Then run `MIX='[["Flute","flute",0,73,104,76],["Nylon Guitar","guitar",1,24,92,44],["Piano","piano",2,0,112,82],["Acoustic Bass","bass",3,32,104,62],["Drums","drums",9,0,80,58]]' node render.mjs 3` (needs /workspace/juniper/lib.mjs). To analyse: `python3 an.py <wav> plan_v3.json`. `build_project.py` writes project.gbk.json.
