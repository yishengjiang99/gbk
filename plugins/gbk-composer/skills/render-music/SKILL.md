---
name: render-music
description: Render a GBK composition to validated WAV and MIDI — submit the job, poll to completion, verify the artifacts, and return authorized download links. Use when the user asks to render, export, hear, or download a piece.
---

# Render music with GBK Composer

Turn a saved composition revision into real, validated audio and MIDI files
and hand the user working, authorized links.

## Account-free project access

No GBK sign-in is required. Without one, `gbk_create_composition` returns
`compositionId`, `accessToken` (private edit capability) and `readAccessToken`
(read-only). Pass `accessToken` on every follow-up call for that project:
read, edit, render, render status/cancel, artifacts, player, Studio link and
publish. It also works in a new MCP session. The composition id or job id alone
grants nothing, and `readAccessToken` cannot edit, render or publish.

- Keep the edit token in private tool context. Never show it in public output
  or put it in a URL. Studio links carry only the read capability (after `#`).
- If the token is missing, ask the user for it; there is no recovery and no
  account to fall back on. Do not silently create a replacement project.
- Stay within `guestLimits` from `gbk_get_capabilities` (length, bars, notes,
  revisions, render requests per day). `QUOTA_EXCEEDED` is final for today;
  say so instead of retrying in a loop.
- Signed-in (OAuth) users keep account-owned projects and need no token. To
  keep a guest project, a signed-in user can call `gbk_claim_composition` with
  the edit token. Delete only on explicit request: `gbk_delete_composition`.

## Rendering without an account (browser only)

The server never synthesizes audio. For account-free projects
`gbk_render_composition` returns `status: "browser_render"`: the MIDI file is
ready immediately (signed `downloadUrl` in `artifacts`), and audio is rendered
in the user's browser through `browserRender`:

1. Call `gbk_show_composition_ui` (with the token) so the in-chat player plays
   and renders the piece locally, or
2. give the user `browserRender.studioUrl` — a private read-only GBK Studio
   link where they can play and export WAV in their browser.

Never claim a WAV exists unless a `wav` artifact is listed.

## Available tools

- `gbk_render_composition` — submit a render job.
- `gbk_get_render_status` — progress, completion, errors, validation data.
- `gbk_get_artifacts` — authorized download URLs for WAV, MIDI, previews.
- `gbk_show_composition_ui` — interactive player and piano roll.
- `gbk_open_workstation` — GBK Studio project URL.

## Procedure

1. **Choose supported settings.** Confirm options against
   `gbk_get_capabilities` if unsure. Supported render parameters:
   - `sampleRate`: 44100 or 48000
   - `channels`: 1 (mono) or 2 (stereo)
   - `format`: `pcm16` or `float32`
   - `normalize`: `loudness` (with `targetLufs`), `peak`, or `off`
   - `tailSeconds`: reverb/release tail to include
   - `includeMidi`: true when the user wants the MIDI file too
   - `waitSeconds`: how long the call may wait before returning a job ID

   Default to 44100 Hz stereo `pcm16` with loudness normalization unless the
   user asked for something else.
2. **Submit the render.** Call `gbk_render_composition` with the
   `compositionId` (the render pins that saved revision). Keep the returned
   `jobId`. Account-free projects get `browser_render` (see above). For
   signed-in users rendering runs in their GBK Studio browser tab: if the result
   is `status: "studio_required"`, give the user the `studioUrl` ("open the
   studio to render"), ask them to keep it open while signed in, then submit
   again. No job exists until then.
3. **Poll appropriately.** If the job is not complete, poll
   `gbk_get_render_status` with increasing waits (use `waitSeconds` /
   backoff rather than rapid repeated calls) until it reaches `completed`
   or `failed`. Do not present a queued or running job as finished audio.
4. **Verify before claiming success.** A render counts as successful only
   when the status is `completed` **and** the result reports
   `validated: true`. Note the actual values: duration, sample rate,
   channels, format, size, and `sha256`. If the job failed or validation
   failed, report the error plainly — never fabricate a file, a checksum,
   or a success message.
5. **Return authorized links.** The completed render/status result already
   carries a signed `downloadUrl` per artifact — present those. Use
   `gbk_get_artifacts` when you need fresh URLs after they expire. Present:
   - the WAV download URL,
   - the MIDI download URL (when `includeMidi` was set),
   - the interactive player via `gbk_show_composition_ui`,
   - the project URL from `gbk_open_workstation`.

   These URLs are authorized and expiring — use only the URLs the tools
   returned, exactly as returned. Never construct, guess, or shorten an
   artifact URL.
6. **Explain the MIDI portability limit.** The WAV is the authoritative
   rendering. The MIDI file preserves notes, tempo and meter maps, program
   changes, and CC automation, but SoundFont-specific voice overrides and
   effects are rendered into the WAV only and cannot be reproduced exactly
   by playing the MIDI through a different synthesizer.

## Rules

- Large audio never travels through the conversation — links only.
- A retry of the same render must not produce conflicting artifacts; reuse
  the same job/result when the server returns one.
- Rendering never publishes a composition. Publishing requires the user's
  explicit request via `gbk_publish_composition`.
