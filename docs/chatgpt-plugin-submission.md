# GBK Composer — ChatGPT plugin submission packet

This document collects the metadata, test prompts, privacy statement, and
manual steps needed to submit GBK Composer for a public plugin listing.

**Status: not submitted. Public approval has NOT occurred.** Nothing in this
document should be read as a claim that GBK Composer is listed, approved, or
installable from any public directory. The steps below that require the
human account owner have not been performed by preparing this packet.

## Submission metadata

- **Plugin name:** GBK Composer
- **Package name:** `gbk-composer` (version 1.0.0)
- **Developer:** Yisheng Jiang
- **Homepage / website:** https://compose.grepawk.com
- **Repository:** https://github.com/yishengjiang99/gbk
- **MCP server:** `gbk_composer` — Streamable HTTP at
  `https://compose.grepawk.com/mcp`, no authentication (project capabilities)
- **Category:** Productivity
- **Capabilities:** Interactive, Write

**Short description**

> Compose, edit, and render structured MIDI music to WAV and MIDI.

**Long description**

> GBK Composer lets you compose, edit, orchestrate, visualize, and render
> MIDI music with a deterministic SoundFont synthesizer, directly from
> ChatGPT or Codex. Create durable compositions with structured
> arrangements — including Baroque fugues, counterpoint, and multi-voice
> writing — modify individual passages without disturbing the rest, control
> expression with MIDI CC automation, and export validated stereo WAV and
> Standard MIDI files. Every composition is saved privately server-side with a project access secret,
> requires no GBK account, can be revised by follow-up prompts, played and inspected in
> an interactive player with a piano-roll view, and opened in GBK Studio
> for full editing.

**Description (manifest)**

> Compose, edit, orchestrate, visualize, and render MIDI music with a
> deterministic SoundFont synthesizer. Generate structured arrangements,
> modify individual passages, control expression, and export WAV and MIDI.

**Keywords:** music, composition, midi, fugue, orchestration

**Useful for:** classical composition, algorithmic counterpoint, fugues,
game soundtracks, film cues, ambient music, MIDI orchestration, and music
programming and experimentation.

**Brand assets:** no logo, icon, or screenshot assets are bundled yet (see
`plugins/gbk-composer/assets/README.md`). Real assets must be supplied by
the account owner before a public submission that requires them — do not
submit placeholder or third-party artwork.

## Test prompts

Use these prompts verbatim when testing the integration and when a
reviewer asks for demonstration prompts.

1. **Compose and render**

   > Compose a 32-bar four-voice Baroque fugue in D minor at 108 BPM with
   > organ instrumentation and expressive CC11 dynamics. Render WAV and
   > MIDI.

   Expected: a new durable composition is created; the render job completes
   with `validated: true`; WAV and MIDI download links and the project URL
   are returned; the interactive player is shown.

2. **Follow-up edit of the same composition**

   > Take the composition you just created. Add stretto in the final eight
   > bars, increase the bass presence, and rerender.

   Expected: the same composition ID is retained, the revision increments,
   only the intended material changes, and a revised render is produced.

   (Related edit prompt from the interface defaults: "Make measures 17–24
   more dramatic. Add an octave doubling to the bass, increase the dynamics
   using CC11, preserve the earlier sections, and render the revised
   piece.")

3. **Visualize and download**

   > Show me the piano roll and let me download both files.

   Expected: the interactive component shows playback and a piano roll
   matching the composition's MIDI timing, and working authorized WAV and
   MIDI download links are provided.

## Privacy and data retention

- **What is stored.** Compositions a user creates through the plugin —
  the structured project data (notes, tracks, sections, controller
  automation, instrumentation, titles, and metadata), their revision
  history, and the rendered artifacts (WAV/MIDI files) produced from them —
  are stored server-side, associated with that user's GBK account.
- **Private by default.** A composition is private to its owner. Creating,
  editing, or rendering a composition never publishes it. A composition
  becomes public only when the user explicitly invokes the publish/share
  operation.
- **Access control.** Private compositions and artifacts are accessible
  only to their account owner or guest project capability holder. Artifact downloads are served through
  authorized, expiring URLs, and authorization is checked again when the
  file is downloaded — not only when the URL is issued. Artifact URLs
  should be treated as short-lived credentials and not shared.
- **Authentication data.** OAuth tokens are validated per request and are
  not stored in project data or embedded in project URLs. The plugin does
  not receive or store the user's ChatGPT credentials.
- **No sale of data.** Composition and account data is not sold. Data is
  used to provide the composition, rendering, and storage features the
  user invoked.
- **Guest capabilities.** Creation returns private edit/read secrets. Keep the edit
  secret out of public output. The private Studio link grants read access only.
  Guest recovery requires the saved secret; an account is not required.
- **Retention.** Artifact bytes expire after the configured retention period
  (30 days by default). Compositions and bounded revision history remain durable.
- **Deletion.** No guest deletion tool is exposed yet. Contact the operator through
  https://compose.grepawk.com for deletion of guest project data.
- **Model-provider note.** Renders requested through ChatGPT run GBK's
  deterministic composition/rendering engine; they do not invoke GBK's
  website LLM agent, so no additional model-provider processing of the
  composition is introduced by a render.

## Manual steps — human account owner only

These steps cannot be completed by preparing this repository. Each requires
the human account owner (or a human with the relevant account access):

- [ ] **Deploy the server.** Deploy the release containing the `/mcp`
      endpoint, OAuth endpoints, and render worker to
      `compose.grepawk.com`, and verify `https://compose.grepawk.com/mcp`
      answers an MCP `initialize` request.
- [ ] **Supply real brand assets** (logo/icon/screenshots), if the target
      directory requires them, and reference them in `plugin.json`.
- [ ] **Add the custom MCP server in ChatGPT.** In the owner's ChatGPT
      account: Plugins → add custom MCP server → URL
      `https://compose.grepawk.com/mcp`.
- [ ] **Verify no-auth access.** Create and render without GBK sign-in. Reconnect
      and edit with the saved project capability; verify another guest cannot read
      the project by ID alone and a read token cannot edit or render.
- [ ] **Run the test prompts above** in the real ChatGPT connection and
      confirm playback, piano roll, downloads, and the Studio deep link.
- [ ] **Prepare the public submission** with the metadata in this packet,
      plus the directory's then-current requirements (reviewer test
      account/instructions, support contact, privacy policy URL).
- [ ] **Submit for public directory review** from the owner's account and
      respond to reviewer questions.
- [ ] **After any approval**, update this document with the listing URL and
      approval date. Until then, the status at the top of this document
      stands: **public approval has NOT occurred.**
