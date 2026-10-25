# SoundFonts for gbk

gbk plays everything through its own SoundFont 2 synth (`sf2-parser.ts` /
`src/sf2/`), so the fonts it can use are plain **SF2** files with GM bank/program
layout. SF3 files (Ogg-compressed samples) are *not* supported by the parser and
were excluded during selection.

Fonts are **not committed as binaries** (except the historic default, below,
and small user-provided uploads under `vendor/`). They follow the repo's
OMR-model pattern: `catalog.json` pins each font's
source repo, commit and SHA-256; `scripts/fetch-soundfonts.mjs` downloads and
verifies them into this directory (gitignored `*.sf2`) at build time, and
`scripts/prepare-soundfonts.mjs` (part of `npm run build`) stages the bundled
ones into `public/static/` and writes `public/static/soundfont-manifest.json`,
which the app fetches at runtime to populate the SoundFont picker
(menu → SoundFont). This gives submodule-style provenance without adding
~190 MB of binaries to git history.

## Catalog

| Font | Size | Delivery | Role |
| --- | ---: | --- | --- |
| GeneralUser GS v2.0.2 | 32.3 MB | bundled `static/` | Default. GM/GS, 261 presets + 13 drum kits. |
| TimGM6mb | 6.0 MB | bundled `static/` | Light GM bank — ~5× faster to load. |
| FluidR3 GM | 148.4 MB | server `/soundfonts/` | HQ GM bank. compose.grepawk.com only (see below). |
| Nostalgic Rock Guitar | 3.3 MB | bundled `static/` | Specialty: single rock-guitar preset (bank 0, program 0). Vendored upload. |
| SMS Drum Kit | 0.07 MB | bundled `static/` | Specialty: single GM drum kit (bank 128, program 0). Vendored upload. |

Sources, pinned commits, SHA-256s and license summaries: `catalog.json`.
Full license texts: `licenses/`. Selection notes:

- **GeneralUser GS** — https://github.com/mrbumpy409/GeneralUser-GS @
  `74d4cfe4042a` (v2.0.2). The file committed in `public/static/` is byte-identical
  to that pin (sha256 `c278464b…`) and is kept as the default; upstream `main`
  is currently a 2.0.3 *beta*, deliberately not adopted. License: free,
  unrestricted use (S. Christian Collins).
- **TimGM6mb** — https://github.com/arbruijn/TimGM6mb @ `d6ad4ed7…`.
  License: GPL-2 (Tim Brechbill / David Bolton).
- **FluidR3 GM** — the Debian `fluid-soundfont` bank (Frank Wen, MIT-style
  license), fetched from the Git LFS blob in https://github.com/ikskuh/zyclone
  @ `ae63975f…`; its LFS oid is the pinned sha256.
- **Nostalgic Rock Guitar / SMS Drum Kit** — user-provided uploads (2026-10-25),
  committed under `vendor/` (catalog field `vendored`, no upstream URL);
  `fetch-soundfonts.mjs` copies them into place sha-verified, like a download.
  Guitar: embedded ICOP "Libre", engineer credit Yingchun Soul / FreePats.
  Drums: no license stated in the binary; engineer credit SylvataDaSylveon.
  Both are single-preset specialty banks, not GM banks — the MCP listing
  (`gbk_list_soundfonts`) describes them from their own SF2 INFO/preset data.

Evaluated and not used: MuseScore_General.sf2 (MIT but 208 MB), FatBoy /
Arachno / the wrightflyer/SF2_SoundFonts collection (no clear redistribution
license in-repo), Roland SC-55 and other ROM-derived banks (copyrighted
samples), freepats (GUS `.pat` files, not SF2).

## The server font (compose.grepawk.com)

FluidR3 GM is too large to ship inside every release tarball, so — like the
launch video under `/media/` — it lives outside the releases in
`/var/www/gbk-composer/soundfonts/` on the server and is served at
`/soundfonts/FluidR3_GM.sf2` (see the location block in `deploy/nginx.conf`).
`deploy/deploy.sh` syncs it there once (sha256-checked) on deploy. The manifest
only lists it for compose builds (`GBK_SOUNDFONT_SERVER=1`, set by
`npm run build:compose`), so the GitHub Pages build never shows a font it
cannot serve.

## Commands

- `npm run fetch:soundfonts` — download/verify the bundled fonts.
- `node scripts/fetch-soundfonts.mjs --server` — also fetch FluidR3 GM.
- `npm run prepare:soundfonts` — fetch + stage + manifest (runs in `npm run build`).
