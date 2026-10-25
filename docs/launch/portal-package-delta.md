# Uploaded portal package vs. current repo

## Which commit produced the uploaded ZIP

The bot built the ZIP from `plugins/gbk-composer/` twice:

1. main `ea1b53c` (after PR #93).
2. A rebuild on branch `listing-category` (the PR #94 content, now main `17edba2`), sent at about 18:28 PT.

The owner has not said which one they uploaded. **Likely the #94 build (`17edba2`), unconfirmed.**
`ea1b53c` → `17edba2` changed only `plugin.json`: category Productivity → Entertainment, short description
"Compose and edit MIDI music" → "Compose music, export WAV/MIDI", one purpose-first paragraph added to the
long description, and the delete negative case reworded. If the portal shows category **Productivity**, the
`ea1b53c` build was uploaded.

## Changes after `17edba2`, classified

| Change | PR / commit | Class |
| --- | --- | --- |
| `gbk_list_soundfonts` + `soundFont` render option | 5e35c33 (main) | Server-only (live tool list grows to 17; no package edit needed) |
| Docs/terms/support/tool-description reconciliation | PR A | Website/docs-only, plus `plugins/gbk-composer/README.md` (package docs; no behavior) |
