# Sorghum Street (Juniper Blue): soul-jazz organ trio shuffle, F, 118 BPM, about 223s
- Drawbar Organ (GM16, lead, organ solo), Jazz Guitar (GM26, head an octave below, solo, chops on 2&4 under organ), Percussive Organ (GM17, comping), Electric Bass (GM33, organ left-hand role: boogaloo riff in head, walking in solos), Standard Kit (shuffle ride with skip, cross-stick then snare backbeat, triplet ghost notes, hat foot 2&4).
- Form (108 bars): Intro vamp 4 | Head A 12 + bridge 8 + A 12 | Guitar solo 24 | Organ solo 24 | Head out bridge 8 + A 12 | Coda 4.
- A: original 12-bar blues (F7 Bb7 F7 Cm7-F7 Bb7 Bdim7 F7 Am7-D7 Gm7 C7 F7-D7 Gm7-C7). Bridge: Bb7 Bb7 Ab7 Ab7 Gm7 C7 Db7 C7.
- Head melody written by hand, original. Solos: blues-scale lines, b3-3 bends, triplet turns; organ solo has a repeated blue-note riff.

## v1
- 222.7s, peak -1.0 dBFS, 0 clipped, RMS -19.0. Low end too heavy (<200 Hz at -1 to -3 dB of total), right-heavy (L/R 0.77-0.84), organ solo under the guitar solo by 1.5 dB.

## v2
- Bass eased, pans pulled toward center, organ solo lifted. Low end -3 to -5 dB. Intro dipped to -23.4.

## v3 (published)
- Intro lifted, organ solo and its drums up, comp eased under the guitar.
- 222.7s, peak -1.0 dBFS (MP3 -1.3), 0 clipped, RMS -20.2 dBFS. Sections -19.4 to -21.1 dB. Offbeat onsets near 2/3 of the beat (shuffle about 1.9:1).

## Reproduce
`python3 compose.py 3 '{"bass":0.88,"organ@Organ solo":1.16,"comp@Organ solo":0.88,"drums@Organ solo":1.06,"Intro":1.18,"comp@Guitar solo":0.9}'`, then
`MIX='[["Drawbar Organ","organ",0,16,106,54],["Jazz Guitar","guitar",1,26,96,72],["Percussive Organ","comp",2,17,80,44],["Electric Bass","bass",3,33,84,64],["Standard Kit","drums",9,0,92,64]]' node render.mjs 3`
(lib.mjs + playwright from /workspace/gbk-pw/node_modules, chrome channel, --enable-features=WebMCPTesting).
`python3 an.py <wav> plan_v3.json` and `python3 tim.py <wav> plan_v3.json` analyse. Studio project from IndexedDB saved as project.gbk.json.
