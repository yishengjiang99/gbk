---
name: compose-music
description: Compose a new piece with GBK Composer — create a durable composition, inspect and refine it, render it, and present the player with WAV/MIDI downloads. Use when the user asks to compose, write, or generate new music.
---

# Compose music with GBK Composer

Create a new composition through the GBK remote MCP tools. GBK supplies
deterministic composition, project state, and rendering; you supply the
musical reasoning.

## Account-free project access

No GBK sign-in is required. Creation returns `compositionId`, `accessToken`
(edit capability), and `readAccessToken`. Keep the edit token in private
conversation/tool context and pass it as `accessToken` on every follow-up
read, edit, render, job-status/cancel, artifact, player, Studio, or publish
call. It also works in a new MCP session. A job ID alone grants no access.
Never display the edit token in public output or place it in a URL. The
Studio URL carries only read access; treat it as a private sharing link.
Do not claim an ID or an MCP session alone can recover a guest project.
If the secret is missing, ask for the saved project capability; do not
create a replacement unless requested. Use `readAccessToken` for read-only
access. Guest creation retries share an idempotency key within the same
MCP session; edits/renders use project-scoped retry keys across sessions.
Stay within `guestLimits` from `gbk_get_capabilities`, including render tail.

## Available tools

- `gbk_get_capabilities` — styles, modes, instruments, render formats, limits.
- `gbk_create_composition` — create a durable project.
- `gbk_get_composition` — inspect structure, tracks, sections, revision.
- `gbk_edit_composition` — typed, revision-safe edits.
- `gbk_render_composition` / `gbk_get_render_status` — render and poll.
- `gbk_get_artifacts` — authorized WAV/MIDI download URLs.
- `gbk_show_composition_ui` — interactive player and piano roll.
- `gbk_open_workstation` — deep link into GBK Studio.

## Procedure

1. **Clarify or infer the musical brief.** Determine form, style, mood, key,
   tempo, time signature, instrumentation, number of voices, and target
   length (bars or duration in seconds). Ask only when a missing choice
   would materially change the result; otherwise state your assumptions.
2. **Check capabilities first.** Call `gbk_get_capabilities` before choosing
   a style, instrument, or render format. Never guess what GBK supports.
   - `style`: `baroque` | `classical` | `pop` | `jazz` | `ambient`
   - Instruments are named, e.g. `violin`, `viola`, `cello`, `harpsichord`,
     `organ`, `piano`, `flute`, `oboe`, `clarinet`, `bassoon`, `horn`,
     `trumpet`, `guitar`, `bass`, `choir`, `strings`, `drums`.
   - `voices`: 3 or 4. `complexity`: 1–5.
3. **Create the composition.** Call `gbk_create_composition` with the brief:
   `title`, `style`, `mood`, `key`, `tempo`, `timeSignature`, `bars` or
   `durationSeconds`, `instrumentation`, `voices`, `complexity`, an optional
   `seed` (reuse it for reproducibility), optional `sections`, and an
   `idempotencyKey` so a retry cannot create a duplicate project. Record the
   returned `compositionId` and `revision`.
4. **Inspect what was generated.** Call `gbk_get_composition` and check the
   sections, tracks, note counts, tempo, and meter against the brief. Do not
   describe music you have not inspected.
5. **Refine before rendering.** Use `gbk_edit_composition` with the current
   `expectedRevision` and typed operations (for example `generate_part`,
   `orchestrate`, `cc_curve` for expression/dynamics) to improve coherence,
   orchestration, and expression. Re-inspect after significant edits.
6. **Render only when the composition is ready.** Follow the render-music
   skill: submit with `gbk_render_composition`, poll `gbk_get_render_status`,
   and wait for `completed`.
7. **Verify the artifacts before claiming success.** From
   `gbk_get_artifacts` / the render result, confirm `validated` is true and
   note the actual `sha256`, duration, sample rate, and channels. Never
   invent a download URL, a checksum, or a duration. If the job failed or
   validation failed, say so plainly and report the error.
8. **Present the result.** Call `gbk_show_composition_ui` so the user can
   listen and see the piano roll, and include the authorized WAV and MIDI
   download links and the GBK Studio project URL from `gbk_open_workstation`.

## Rules

- Creating or rendering a composition does **not** publish it. Call
  `gbk_publish_composition` only when the user explicitly asks to publish or
  share the piece publicly.
- Keep the `compositionId` for the whole conversation so follow-up requests
  edit this piece instead of starting a new one.
- Never claim a render succeeded on a failed, incomplete, or unvalidated job.
