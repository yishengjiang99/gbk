# Cedar Switch (Juniper Blue): cool / West Coast jazz, Eb major, 104 BPM, about 151s
- Quintet: Tenor Sax (GM66, lead), Vibraphone (GM11, intro/fills/solo), Acoustic Grand Piano (GM0, rootless voicings), Acoustic Bass (GM32, walking), Standard Kit (ride-heavy: ride 51, snare 38 on 2&4, hats 42/46, kick 36).
- Form (64 bars): Intro 4 | Head A 8 | Head B 8 | Vibes solo 16 (A+B) | Tenor solo 16 (A+B) | Head out A 8 | Coda 4.
- Harmony: cool ii–V–I chains, backdoor Db7, Ab7 color, Am7b5–D7 approach to Gm7.
- Head melody is written by hand and original. Solos are written lines: chord tones on strong beats, scale steps between; tenor solo adds double-time sixteenth runs.

## v1
- 150.8s, peak -1.00 dBFS, 0 clipped, RMS -19.1. Presence buried in heads/tenor (~-15 to -16 dB). Vibes solo louder than tenor.

## v2
- ARC lifts on tenor; bass eased; vibes fader up. Presence improved (~-8 dB) but overall RMS dropped to -22.5; vibes solo still dominated LUFS.

## v3
- Vibes solo eased, tenor solo and heads lifted, vibes pan centered. RMS -18.4, presence -7.8 to -10.1, sections more even.

## v4 (published)
- Further tenor solo lift, vibes solo eased, then -0.6 dB master trim.
- 150.8s, peak -1.65 dBFS (MP3 similar), 0 clipped, RMS -19.0 dBFS.
- Section RMS: intro -20.1 | A -18.5 | B -18.3 | vibes solo -16.7 | tenor solo -19.0 | head out -18.7 | coda -21.2.
- Presence (1–4 kHz) about -8 to -10 dB across lead sections.

## Reproduce
`python3 compose.py 4 '<ARC json from above>'`, then
`MIX='[["Tenor Sax","tenor",0,66,114,66],["Vibraphone","vibes",1,11,84,58],["Acoustic Grand Piano","piano",2,0,88,54],["Acoustic Bass","bass",3,32,98,62],["Standard Kit","drums",9,0,86,64]]' node render.mjs 4`
(needs lib.mjs + playwright from /workspace/gbk-pw/node_modules, chrome channel, --enable-features=WebMCPTesting).
`python3 an.py <wav> plan_v4.json` analyses. Studio export used as project.gbk.json.
