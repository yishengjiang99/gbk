# GBK song catalog and song videos

Every song is a folder in this repo, published like a blog post, and shown at
<https://yishengjiang99.github.io/gbk/songs/> (built from `songs/` at build time).

```
songs/
  recipes/<name>.json            # input: the tool-call recipe (what the composer agent did)
  <yyyy-mm-dd>-<slug>/
    song.json                    # metadata, recipe + tool-call log, loudness, SHA-256 of every file
    project.json                 # full GBK project (used by "Open in workstation": /gbk/?song=<dir>)
    song.mid                     # MIDI export (tempo, meter, key, section markers, CCs)
    song.mp3                     # 192 kbps MP3 for the page / quick download
    video.mp4                    # 1920x1080 H.264 + AAC piano-roll video
    poster.png                   # 1080p still (40 % into the song)
    notes.md                     # optional liner notes (from recipe.notes)
    song.wav                     # NOT committed (gitignored) -> GitHub Release asset song-<dir>
```

**Why the WAV is a Release asset.** A 75 s 44.1 kHz stereo WAV is ~13 MB and every re-render would add another copy to
git history forever. MP4 (~8 MB) and MP3 (~2 MB) are committed so the page works from Pages alone; the lossless WAV is
uploaded to the release `song-<dir>` and `song.json.files.wav.url` / the gallery's WAV link point there. Its SHA-256 is
in `song.json`, so anyone can verify the download.

## Publish a new song (composer agent)
```
npm ci                                   # once; needs Chrome (or Playwright Chromium) and ffmpeg on PATH
npm run song:publish -- songs/recipes/<name>.json [--date YYYY-MM-DD] [--fps 30|60]
git checkout -b song/<yyyy-mm-dd>-<slug>
git add songs/recipes/<name>.json songs/<yyyy-mm-dd>-<slug>
git commit -m "song: <Title>" && git push -u origin HEAD   # open a PR; merging to main deploys the gallery
npm run song:release -- songs/<yyyy-mm-dd>-<slug>          # uploads song.wav as release asset song-<dir> (gh auth)
```
`song:publish` starts a Vite dev server on a free port, launches Chrome **without flags** (tools via the in-page
`window.gbkTools` shim), runs the recipe's `steps` as `gbk_*` tool calls, renders the WAV (`gbk_render_wav`, default
loudness normalization -16 LUFS / -1 dBTP), reads the WAV and MIDI back with `gbk_read_wav_bytes` (SHA-256 checked),
draws the video frames and muxes them with the WAV in ffmpeg, then writes the folder. No clicks, no audio device.

### Recipe format
```json
{ "title": "…", "slug": "optional-slug", "composer": "Dr dre (Composer bot)", "description": "…", "notes": "optional markdown",
  "steps": [ { "tool": "gbk_create_project", "args": { "name": "…", "tempo": 108, "key": "C minor", "replaceCurrent": true } },
             { "tool": "gbk_create_track", "args": { "name": "Violin", "program": 40 } },
             { "tool": "gbk_generate_cc_curve", "args": { "trackIds": ["$track[0]"], "controller": 11, "shape": "decrescendo", "from": 110, "to": 45, "range": { "unit": "bars", "start": 29, "end": 32 } } },
             { "tool": "gbk_commit_proposal", "args": { "proposalId": "$proposal" } } ],
  "render": { "sampleRate": 44100, "channels": 2, "tailSeconds": 3 } }
```
`$track[i]` is the i-th track id returned by `gbk_create_track` calls; `$proposal` is the last returned `proposalId`.
Start with `gbk_create_project` (`replaceCurrent: true`). See `songs/recipes/midnight-invention.json`.

Re-render only the video (e.g. after changing the look): download the WAV
(`gh release download song-<dir> -R yishengjiang99/gbk -D songs/<dir>`) then `npm run song:video -- songs/<dir>`.

## Video renderer
`src/video/piano-roll-video.ts`: `buildVideoModel(project, wavDuration)` converts ticks to seconds through the
tempo map; `drawFrame(ctx, model, t)` draws a scrolling piano roll (8 s window, playhead at 30 %), notes in track colors,
sounding notes outlined and their keys lit on the keyboard, title/key/tempo/meter/composer header, current section,
section markers, bar lines, legend and progress bar. Frame *i* shows time *i / fps*, and there are
`ceil(duration × fps)` frames, so audio and video both start at 0 and end within one frame of each other.
Frames are PNGs from an `OffscreenCanvas` in headless Chrome, piped into ffmpeg (`libx264 -crf 20 yuv420p`, AAC 192k,
bitexact flags, `+faststart`). Everything is deterministic: two publishes of the same recipe produced byte-identical
WAV, MIDI, MP3, MP4 and poster.

No WebMCP `gbk_render_video` tool yet: producing an MP4 inside the page would need a JS MP4 muxer (WebCodecs gives
only the H.264 stream), which is not cheap to add. Agents use `npm run song:publish` / `song:video` instead.

## Tests
- `test/song-video.test.ts` (unit): tempo-map timing, frame count/time, onset-frame highlighting at 30/60 fps,
  recipe substitution, gallery ordering/escaping/links.
- `test/e2e/song-video.spec.ts` (`npx playwright test --project=chrome-song`, Chrome without flags, needs ffmpeg):
  frame determinism; A/V sync on rendered WAV + video with separated onsets at 30 and 60 fps (decoded MP4: lit-key
  onset frame vs. audio onset, ≤ 1 frame); published-song ffprobe checks (1080p, frame count, durations, start times,
  SHA-256); gallery listing, video metadata, downloads and "Open in workstation".
