# Uploaded portal package vs. current repo

## Which commit produced the uploaded ZIP — confirmed: `ea1b53c`

The owner shared the ZIP they uploaded. All 10 files match `plugins/gbk-composer/` at main `ea1b53c`
(after PR #93) byte for byte. Against `17edba2` (PR #94) only `plugin.json` differs, so **the #94 listing
metadata is NOT in the uploaded package** (the portal still has category Productivity, short description
"Compose and edit MIDI music", no purpose-first paragraph, and the old delete negative case).

## Changes after `ea1b53c`, classified

| Change | PR / commit | Class |
| --- | --- | --- |
| Category → Entertainment, short desc "Compose music, export WAV/MIDI", purpose-first long description, delete negative case reworded | #94 (`17edba2`) | **Package change: needs a replacement ZIP** (or the same edits in the portal form) |
| `gbk_list_soundfonts` + `soundFont` render option | 5e35c33 | Server-only (live tool list grows to 17; no package edit needed) |
| Docs/terms/support/tool-description reconciliation | #96 | Website/docs-only, plus `plugins/gbk-composer/README.md` (package docs; no behavior) |
| Studio scrubber, mobile transport, video export, durable sessions, read-only share fix | #97 #101 #98 #102 | Server/website-only |
| History-free review cases + third starter prompt no longer says "my last piece" | #99 | **Package change: needs a replacement ZIP; reviewer test cases change** |

| Demo gallery (public), /chatgpt featured demos, install-click redirect, analytics counters, againstTrack description, nginx deploy safety, CI/smoke, launch docs | #105, da5b20c, 95a3b4e, 1171aeb, Phase 5–8 commits | Server/website/docs-only: no package change after `d329875` |

## Release recommendation

Build one replacement ZIP from `plugins/gbk-composer/` at the main commit that contains #99. It carries the
#94 listing changes and the #99 review cases together. The owner uploads it through the portal; the bot never
does. Until then the live server is backward compatible with the uploaded `ea1b53c` package (same tool
names; the old review cases still work, but the "my last piece"/"my jazz piece" cases depend on history).

## Owner portal checklist (portal-only)

- [ ] Upload the replacement ZIP (or apply the #94 and #99 `plugin.json` edits in the form).
- [ ] Check that category = Entertainment and short description = "Compose music, export WAV/MIDI".
- [ ] Check that the review test cases match the new `plugin.json` (5 positive, 3 negative).
- [ ] MCP URL is still `https://compose.grepawk.com/mcp`; no auth required.
- [ ] Do not submit or publish until you decide to.
