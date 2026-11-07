# Ironwood Run (Juniper Blue): uptempo hard bop, C minor, 168 BPM, about 174s
- Quintet: Trumpet (GM56, lead), Tenor Sax (GM66, harmony under the head, soloist), Acoustic Grand Piano (GM0, rootless comping), Acoustic Bass (GM32, walking with chromatic approaches), Standard Kit (spang-a-lang ride 51, hat foot 44 on 2&4, feathered kick, snare comping, fills).
- Form (120 bars): Intro 4 | Head AABA 32 | Trumpet solo 32 | Tenor solo 16 (A+B) | Trading fours 16 (trumpet/drums/tenor/drums) | Head out B+A 16 | Coda 4.
- Harmony: minor ii-V (Dm7b5 G7alt) into Cm7, iv-bVII-bIII, bridge of ii-V chains (Gm7 C7, Bbm7 Eb7, Am7b5 D7) to Ab7 and G7alt.
- Head melody is written by hand and original; tenor harmonizes each note with a chord tone a 3rd-6th below. Solos are written bebop lines: chord tones on strong beats, enclosures, triplet bursts, guide-tone targets.

## v1
- 174.3s, peak -2.4 dBFS, 0 clipped, RMS -18.1. Swing ratio about 0.6 (onset peak at 7/12 of the beat). Bass too heavy; tenor solo buried (presence -19.4 dB).

## v2
- Bass eased, tenor solo moved up a 4th and lifted. Tenor solo presence -12.4 dB.

## v3
- Bass and piano eased under the tenor solo. Presence -9.7 dB but the section dipped to -20.7 RMS.

## v4 (published)
- Tenor fader up, rhythm section restored under the tenor solo.
- 174.3s, peak -1.8 dBFS (MP3 -2.1), 0 clipped, RMS -18.8 dBFS. Sections -17.5 to -20.0 dB.

## Reproduce
`python3 compose.py 4 '{"tenor@Tenor solo":1.2,"bass@Tenor solo":0.95,"piano@Tenor solo":0.95,"drums@Tenor solo":1.08,"bass":0.9,"drums@Trading fours":0.92}'`, then
`MIX='[["Trumpet","trumpet",0,56,100,72],["Tenor Sax","tenor",1,66,112,58],["Acoustic Grand Piano","piano",2,0,86,48],["Acoustic Bass","bass",3,32,90,64],["Standard Kit","drums",9,0,90,64]]' node render.mjs 4`
(needs lib.mjs + playwright from /workspace/gbk-pw/node_modules, chrome channel, --enable-features=WebMCPTesting).
`python3 an.py <wav> plan_v4.json` and `python3 tim.py <wav> plan_v4.json` analyse. Studio project from IndexedDB saved as project.gbk.json.
