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
  `https://compose.grepawk.com/mcp`, OAuth authorization
- **Category:** Productivity
- **Capabilities:** Interactive, Write

**Display name:** GBK Composer

**Short description** (≤30 chars)

> Compose and edit MIDI music

**Long description**

> GBK Composer writes and edits real MIDI music from a chat. Ask for a piece in one of five styles (baroque, classical, pop, jazz, ambient) with a key, tempo, meter, length and instruments, and GBK builds a structured, multi-track arrangement with a deterministic, seeded engine. Baroque requests use a Bach-style fugue generator with continuo.
>
> Follow-up prompts change one passage without touching the rest: add a melody, bass, walking bass, chords, arpeggio, drums or counterpoint part; transpose, invert, quantize, humanize or vary notes; double a line at the octave; shape dynamics with CC curves such as a CC11 crescendo; and change tempo, instruments or the mix. Every edit is saved as a new revision.
>
> Instruments come from the bundled GeneralUser GS SoundFont, including violin, viola, cello, strings, harpsichord, piano, organ, flute, oboe, clarinet, bassoon, horn, trumpet, guitar, bass, choir and drums.
>
> To hear a piece, GBK shows an in-chat player with a piano roll, track list and dynamics lanes. WAV and Standard MIDI renders run in your own browser: keep a signed-in GBK Studio tab open at compose.grepawk.com and GBK renders there, then returns download links. If no Studio tab is open, GBK gives you a link to open one.
>
> Compositions are private to your GBK account. GBK publishes a public share page only when you ask it to.

**Description (manifest)**

> Compose and edit structured MIDI music in five styles, shape dynamics with CC automation, preview it in a piano-roll player, and render WAV and MIDI in your GBK Studio browser tab.

**Keywords:** music, composition, midi, fugue, orchestration

**Useful for:** classical composition, algorithmic counterpoint, fugues,
game soundtracks, film cues, ambient music, MIDI orchestration, and music
programming and experimentation.

**Brand assets:** ICON PLACEHOLDER — the listing icon will be supplied by the owner (`plugins/gbk-composer/assets/icon.png`, then reference it from `plugin.json`). No logo, icon, or screenshot assets are bundled yet (see
`plugins/gbk-composer/assets/README.md`). Real assets must be supplied by
the account owner before a public submission that requires them — do not
submit placeholder or third-party artwork.

## Test prompts

These are the `defaultPrompt` starter prompts (≤128 chars each, max 3; checked by `server/test/mcp-listing.test.ts`). Rendering needs a signed-in GBK Studio tab open in the browser; without one the render tool returns a studio link.

1. > Compose a 16-bar Baroque fugue in D minor for organ, then show me the piano roll.

   Expected: A new private composition (style baroque, organ, D minor, 16 bars) is created and the interactive player with piano roll is shown.

2. > Write a 24-bar jazz piece in F major at 140 BPM, add a walking bass, then render WAV and MIDI.

   Expected: A jazz composition is created, a `walking_bass` part is generated via `gbk_edit_composition`, and with a Studio tab connected the render returns WAV and MIDI download links (otherwise `studio_required` + studioUrl).

3. > In my last piece, double the bass an octave lower in bars 9–16 and add a CC11 crescendo.

   Expected: `gbk_list_compositions` finds the latest piece; one edit applies `orchestrate` (semitones -12, bars 9–16) and a `cc_curve` crescendo on CC11; revision increments and other sections are unchanged.

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
  only to their authenticated owner. Artifact downloads are served through
  authorized, expiring URLs, and authorization is checked again when the
  file is downloaded — not only when the URL is issued. Artifact URLs
  should be treated as short-lived credentials and not shared.
- **Authentication data.** OAuth tokens are validated per request and are
  not stored in project data or embedded in project URLs. The plugin does
  not receive or store the user's ChatGPT credentials.
- **No sale of data.** Composition and account data is not sold. Data is
  used to provide the composition, rendering, and storage features the
  user invoked.
- **Retention.** Compositions, revisions, and artifacts are retained while
  the user's GBK account exists or until the user deletes them, so that
  follow-up edits and re-renders remain possible.
- **Deletion.** A user can delete a composition (and its rendered
  artifacts) from GBK Studio, or request deletion of their account data by
  contacting the developer through https://compose.grepawk.com. Deletion
  removes the project data and its artifacts from primary storage.
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
- [ ] **Complete OAuth linking.** Sign in to GBK in the OAuth flow and link
      the ChatGPT client to the owner's GBK account; confirm a test
      composition appears under that account in GBK Studio.
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
