# 2026-11-25 Juniper Blue: three drafts

## d1 Tamarind Steps: jazz samba, A minor, 192 BPM straight, soprano sax, piano (partido alto), bass, samba kit. 104 bars, 134 s.
- Hook & melody: catchy long-tone hook with 4& anticipations, but every 2 bars repeat one rhythm (rest-2, pickup, 3, 1, tie-5). It turns formulaic by the bridge.
- Harmony: solid A minor ii-V work, nice Am9 / Bb7#11 vamp. Bridge is a plain descending ii-V chain.
- Structure: short (A16 B8 head, one 24-bar sop solo, 16-bar piano solo). No contrast between head in and out.
- Groove: samba bass and partido-alto comp sit right; hi-hat eighths at 192 are busy and mechanical.
- Mix (stems, unnormalised): sop -34.6, piano -45.2, bass -44.6, drums -38.3 dB. Sop 10 dB over the band; piano leans left (L/R 1.31); piano solo section 4 dB under the rest.
- Fit: Brazilian, close to the bossa (Tidepool Postcard). Least Juniper Blue of the three.

## d2 Hollyhock Stride: stride-piano trio, G major, 132 BPM swing, piano, bass, brushes. 88 bars, 162 s.
- Hook & melody: warm pentatonic hook, singable bridge sequence. Pleasant but tame.
- Harmony: I-VI-ii-V, passing diminished, backdoor Cm6-F7 in the bridge. Correct but generic, reads like pastiche of a 1930s standard.
- Structure: good textural idea (stride LH in the A sections, walking bass + comping in bridges and second half of the solo).
- Groove: stride LH at 132 is stiff; the oom-pah plus brushes lacks swing lift.
- Mix: piano -37.5, bass -44.4, drums -45.8 dB. Piano carries everything; drums buried. Mix leans right (L/R 0.88, high RH notes image right).
- Fit: fresh for Juniper (no horns), but least modern harmony.

## d3 Flintlock Alley: uptempo bebop, Ab major, 208 BPM, muted trumpet + vibes head in octaves, piano, bass, drums, fours with drums. 156 bars, 182 s.
- Hook & melody: real bebop line with a recurring opening cell (Eb-F-G-Ab-C), chromatic alt-dominant turns, bridge in rising/falling sequences. Strongest tune.
- Harmony: ii-V-I in Ab, Ab7-Dbmaj7-Gb7 lift in bar 5-6, bridge shifts a tritone (Em7 A7 Dmaj7, Ebm7 Ab7 Dbmaj7) then steps home. Freshest changes.
- Structure: intro, AABA head, two full solo choruses, fours with drums, head out, tag. Best form; the trades add drama.
- Groove: walking bass, ride and comping swing well at 208.
- Mix: tpt -44.0, vibes -31.1, piano -46.9, bass -44.7, drums -42.6 dB. Vibes 13 dB over the trumpet lead; mix leans right (vibes pan 74, L/R 0.61 in the head); piano hard left (L/R 2.15). Coda melody ran past the last bar.
- Fit: most Juniper Blue (swing, ii-V, written solos), and bebop on muted trumpet + vibes is new for the catalogue.

## Pick: d3 Flintlock Alley
Best melody, harmony and form; its problems are mix and a coda bug, both fixable. d1 is too formulaic and close to the bossa; d2 is charming but generic.

## Revision of d3 (v2, published), `d3r.py`
- Mix: vibes vol 96 -> 42 (pan 74 -> 68), trumpet vol 127 (pan 58 -> 62), piano pan 54 -> 63, bass 50 -> 43, drums 100 -> 88. Vibes +20% velocity in its solo and its four.
- Writing: trumpet solo opens with a 4-bar development of the head cell; vibes solo opens with a 4-bar descending answer. Coda is now a 6-bar tag (three hook statements over Bbm7-Eb7, Ab6), so no notes run past the end.
- Stems unnormalised: tpt -43.1, vibes -44.2, piano -47.0, bass -47.4, drums -45.0 dB. Sections -18.2 to -20.1 dB (intro -22.8), L/R 0.87-1.11, peak -2.0 dBFS, 0 clipped. Muted trumpet is bright (much energy above 4 kHz): harmon-mute character.

## Reproduce
`python3 d3r.py d3v2` then `node render.mjs d3v2` (playwright from /workspace/gbk-pw/node_modules). Stems: `python3 stems.py d3v2`, `NORM=none bash q.sh d3v2S<track>...`, `python3 stemlev.py d3v2`. Melody check: `python3 d3.py lint`.
