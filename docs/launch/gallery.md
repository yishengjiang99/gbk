# Demo gallery (#72 Phase 4)

Status: **built, private preview only.** The six demos live on the server in `$COMPOSER_DATA_DIR/gallery`
(not in git, not public). `GET /chatgpt/gallery` and its WAV/MIDI downloads return 404 for everyone except
`COMPOSER_ADMIN_USERS`. The page is noindex and no-store and isn't in the sitemap. Nothing is linked from
/chatgpt, Explore, or song pages until the owner approves the assets (see "Making it public").

## How demos are made (no hand-made data)

`scripts/gallery/recipes.ts` holds one recipe per demo: the user-style prompt, one `gbk_create_composition` call
with a fixed seed, and typed `gbk_edit_composition` operations. `scripts/gallery/build.ts` replays each recipe
through the public MCP endpoint. It creates the composition (private, no sign-in), applies the edits, reads all
notes, renders on the server (`gbk_render_composition`), downloads the WAV and SMF, checks their sha256 against the
job, and validates them: RIFF/WAVE 44.1 kHz, not silent; SMF chunks parse exactly. Then it deletes the composition
with its own key. Explanations come from `explain()` in `server/src/gallery.ts`, which reads the notes and the CC11
events in the exported SMF. Every sentence is a measured fact (bars, tempo, key, ranges, entries, quarter-note
share, CC11 direction). Access tokens are never written or printed.

```
node --import tsx/esm scripts/gallery/build.ts https://compose.grepawk.com ./gallery-out --server-commit <sha>
rsync -a ./gallery-out/ root@HOST:/var/lib/gbk-composer/gallery/ && ssh root@HOST chown -R www-data: /var/lib/gbk-composer/gallery
```

## Demos (build of 2026-10-25 against prod commit d329875)

| Demo | Tracks | Length | Result vs the brief |
| --- | --- | --- | --- |
| Baroque Fugue in D minor (organ ×4, seed 1720, CC11 crescendo) | 4 | 16 bars, 50.5 s | **Partial.** Four organ voices and CC11 are present, but all four start together in bar 1. The engine does not produce a staggered subject/answer exposition, and `generate_fugue_section` doesn't either (checked). Engine gap, not faked. |
| Two-Part Invention in F major (harpsichord ×2, seed 1723) | 2 | 12 bars, 30.0 s | Melody + `counterpoint` against it. Both voices start in bar 1; imitation is not measured or claimed. |
| Orchestral Cue in C minor (violin, viola, cello, flute, clarinet, horn, trumpet; seed 2024) | 7 | 24 bars, 68.6 s | Strings, woodwinds, and brass. Intro/Build/Climax sections; CC11 from 50 to 127 plus a string swell. |
| Game Soundtrack Loop in E minor (seed 3132) | 4 | 16 bars, 29.1 s | A (theme) and B (contrast) sections, drums and bass. **Loopability is not verified** (no check that bar 16 leads back to bar 1). |
| Ambient Piano in A major (seed 6464) | 1 | 16 bars, 60.0 s | Solo piano, CC11 crescendo. |
| Jazz in F major with Walking Bass (seed 140) | 4 | 24 bars, 41.1 s | Trumpet, piano chords, bass rewritten with `walking_bass` (100% quarter notes), drums, CC11 crescendo. |

Each demo on the page has: a playable WAV, a static SVG piano roll, the track list (GM instrument, note count,
controllers), the explanation, WAV/MIDI downloads, and the recipe JSON plus seed/revision/renderer/commit/sha256
(reproducibility record). The same recipe + seed + server commit reproduces the same notes.

Finding: `gbk_edit_composition`'s `generate_part kind: counterpoint` requires an `againstTrack` field, but the
tool description doesn't mention it. Models will hit INVALID_ARGUMENT ("counterpoint needs againstTrackId").
Worth a description fix in a later PR (server-only, no package change).

## Making it public (needs owner approval)

1. The owner reviews the six demos at /chatgpt/gallery (signed in as an admin).
2. On approval: a follow-up PR removes the admin gate, adds the page to the sitemap, and links three featured
   demos (`featured: true`: fugue, orchestral cue, ambient piano) from /chatgpt and Explore.
3. Until then no demo media or composition is public.

Package effect: none (server and docs only; the uploaded ZIP is unchanged).
