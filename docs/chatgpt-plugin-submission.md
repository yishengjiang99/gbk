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
  `https://compose.grepawk.com/mcp`, no authentication required (per-project
  access keys); OAuth sign-in optional for existing GBK accounts
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
> No account is needed. To hear a piece, GBK shows an in-chat player with a piano roll, track list and dynamics lanes. Press Render and the WAV is synthesized right in your browser with the GBK SoundFont engine, plays in the chat, and can be downloaded; GBK also exports a Standard MIDI file. No Studio tab is needed. Clients without a browser (such as Codex) get the WAV and MIDI rendered on GBK's server instead.
>
> Each composition is private and opened only with the access key returned to your chat. GBK publishes a public share page only when you ask it to.

**Description (manifest)**

> Compose and edit structured MIDI music in five styles, shape dynamics with CC automation, preview it in a piano-roll player, render and play WAV in your browser right in the chat, and download MIDI. No account needed.

**Keywords:** music, composition, midi, fugue, orchestration

**Useful for:** classical composition, algorithmic counterpoint, fugues,
game soundtracks, film cues, ambient music, MIDI orchestration, and music
programming and experimentation.

**Brand assets:** `plugins/gbk-composer/assets/icon.png` (512×512, from `icon.svg`) is set as `interface.logo` and `interface.composerIcon`. Brand colors: `#3A2E9E` (light) and `#FFB627` (dark).

**Listing URLs:**
- Website: https://compose.grepawk.com/chatgpt
- Privacy policy: https://compose.grepawk.com/privacy
- Terms of service: https://compose.grepawk.com/terms
- Support: https://compose.grepawk.com/support (routes to GitHub issues)

## Test prompts

These are the `defaultPrompt` starter prompts (≤128 chars each, max 3; checked by `server/test/mcp-listing.test.ts`). The in-chat player's Render button synthesizes audio in the user's browser and needs no Studio tab or extra sign-in. `gbk_render_composition` renders WAV and MIDI on GBK's server (or in a connected Studio tab, if there is one).

1. > Compose a 16-bar Baroque fugue in D minor for organ, then show me the piano roll.

   Expected: A new private composition (style baroque, organ, D minor, 16 bars) is created and the interactive player with piano roll is shown.

2. > Write a 24-bar jazz piece in F major at 140 BPM, add a walking bass, then let me render and play it in the chat.

   Expected: A jazz composition is created, a `walking_bass` part is generated via `gbk_edit_composition`, and the in-chat player is shown (`gbk_show_composition_ui`). Pressing Render synthesizes the WAV in the browser (progress %, Stop), plays it, and saves WAV + MIDI download links. If the model calls `gbk_render_composition` instead, the WAV and MIDI are rendered on GBK's server and returned as signed download links.

3. > In my last piece, double the bass an octave lower in bars 9–16 and add a CC11 crescendo.

   Expected: `gbk_list_compositions` finds the latest piece; one edit applies `orchestrate` (semitones -12, bars 9–16) and a `cc_curve` crescendo on CC11; revision increments and other sections are unchanged.

## OpenAI review material (prepared, not submitted)

The test cases and release notes below are also in `plugin.json` under `extensions.com.openai.review` / `publication`, so a ZIP upload imports them. Reviewer credentials are **not** in the package; enter them in the portal's Review details form.

### Positive test cases (5)

1. **Compose a new Baroque fugue and show it in the interactive player.**
   - Prompt: "Compose a 16-bar Baroque fugue in D minor for organ, then show me the piano roll."
   - Tools: gbk_create_composition, gbk_show_composition_ui
   - Expected: A new private composition (baroque, D minor, 16 bars, organ voices) is created and the GBK player shows its piano roll, tracks and CC11 lane.
2. **Compose, add a part with a targeted edit, and render it in the in-chat player (no Studio tab).**
   - Prompt: "Write a 24-bar jazz piece in F major at 140 BPM, add a walking bass, then let me render and play it in the chat."
   - Tools: gbk_create_composition, gbk_get_composition, gbk_edit_composition, gbk_show_composition_ui (player calls gbk_widget_render_start / gbk_widget_render_finish); optionally gbk_render_composition (server render)
   - Expected: A jazz composition is created and a walking_bass part generated; the GBK in-chat player is shown. Pressing Render in the player synthesizes the WAV in the user's browser with progress and Stop, plays it in the chat, and saves validated WAV and MIDI download links. If the model calls gbk_render_composition instead, it renders the WAV and MIDI on GBK's server (no Studio tab needed) and returns signed download links.
3. **Edit only a passage of the most recent composition.**
   - Prompt: "In my last piece, double the bass an octave lower in bars 9–16 and add a CC11 crescendo."
   - Tools: gbk_list_compositions, gbk_get_composition, gbk_edit_composition
   - Expected: The latest composition is found, the bass is doubled at -12 semitones in bars 9–16 and a CC11 crescendo is added; the revision increments and other sections are reported unchanged.
4. **Retrieve download links for rendered files.**
   - Prompt: "Give me the download links for the WAV and MIDI of my jazz piece."
   - Tools: gbk_list_compositions, gbk_get_artifacts
   - Expected: Short-lived signed WAV and MIDI download URLs with size and SHA-256 are returned for the latest render.
5. **Publish only on explicit request.**
   - Prompt: "Publish my jazz piece as a public share page."
   - Tools: gbk_list_compositions, gbk_publish_composition
   - Expected: The composition becomes public and a share page URL is returned. No other composition changes visibility.

### Negative test cases (3)

1. Prompt: "Write lyrics for a summer pop song and have a singer perform them." — Lyrics and sung vocals are out of scope: GBK writes instrumental MIDI only.
2. Prompt: "Delete all of my GBK compositions." — There is no delete tool; the plugin must not claim to delete or modify unrelated data.
3. Prompt: "What's the weather in Paris tomorrow?" — Unrelated request; the plugin should not be invoked.

### Release notes

> 1.0.0: first public release. Compose in five styles (baroque, classical, pop, jazz, ambient) with a deterministic, seeded engine; targeted revision-safe edits (parts, transforms, octave doubling, CC curves, tempo, instruments, mix); interactive piano-roll player; WAV and MIDI rendered in the in-chat player in the user's browser, or on GBK's server for clients without a browser; compositions private until the user asks to publish.

### Tool annotation justifications

| Tool | readOnly | openWorld | destructive | Justification |
| --- | --- | --- | --- | --- |
| `gbk_get_capabilities` | true | false | false | Only returns static capability data; changes nothing and calls nothing outside GBK. |
| `gbk_create_composition` | false | false | false | Creates a new private composition (in the user's GBK account, or account-free with a private access key); it overwrites nothing and is not visible to anyone else. |
| `gbk_get_composition` | true | false | false | Reads one of the user's compositions; no changes. |
| `gbk_list_compositions` | true | false | false | Lists the user's own compositions; no changes. |
| `gbk_edit_composition` | false | false | false | Writes a new revision of the user's private composition; earlier revisions are kept, so nothing is lost, and nothing becomes public. |
| `gbk_render_composition` | false | false | false | Creates a render job producing a WAV and a MIDI file, rendered on GBK's server when no Studio tab is connected (or in a connected Studio tab), returned as signed download links. It changes no content and publishes nothing. |
| `gbk_widget_render_start` / `gbk_widget_render_finish` | false | false | false | App-only (`ui.visibility: ["app"]`), called by the in-chat player's Render button: create the user's own render job and publish the WAV their browser rendered (server verifies SHA-256 and the WAV header) plus a server-built MIDI file; nothing is published publicly. |
| `gbk_get_render_status` | true | false | false | Reads render job status; no changes. |
| `gbk_cancel_render` | false | false | false | Stops the user's own queued or running render job; no composition data is deleted and nothing is published. |
| `gbk_get_artifacts` | true | false | false | Returns signed download links to the user's own files; no changes. |
| `gbk_open_workstation` | true | false | false | Returns a deep link into GBK Studio; no changes. |
| `gbk_publish_composition` | false | true | false | Makes the composition publicly viewable on a share page (open world). Called only on explicit user request; not destructive because it deletes nothing. |
| `gbk_delete_composition` | false | false | true | Permanently deletes the caller's own account-free composition; requires that project's edit key and an explicit user request. |
| `gbk_claim_composition` | false | false | false | Moves an account-free composition the caller holds the edit key for into their signed-in GBK account; nothing is deleted or published. |
| `gbk_show_composition_ui` | true | false | false | Renders a read-only player for the user's composition; no changes. |

### Review details: no sign-in needed

The plugin works without any account: connect with **No authentication** and run the test prompts. Each composition returns a private `accessToken` that ChatGPT passes on follow-up calls; audio plays in the in-chat player (rendered in the browser), MIDI downloads come from the server, and the private Studio link opens the piece read-only in GBK Studio.

### Optional: reviewer account (signed-in path)

GBK normally uses Google sign-in only. For app review there is one username/password account, `openai-reviewer`. The owner enters the password in the portal's **Review details** form; it is never in the package or the repo.
1. In ChatGPT, connect GBK Composer. The OAuth page at `https://compose.grepawk.com/oauth/authorize` asks the user to sign in.
2. Click **Reviewer sign-in**, enter `openai-reviewer` and the password, and submit. You return to the same authorization request.
3. Approve the consent screen. ChatGPT is now connected as the reviewer account, which has the same daily AI and render limits as any new account.
4. No Studio tab is needed. The in-chat player's Render button renders in the browser, and `gbk_render_composition` renders on GBK's server.

Server settings: `REVIEWER_LOGIN_ENABLED=1` and `REVIEWER_PASSWORD_HASH` (an scrypt hash) in `/etc/gbk-composer.env`. To turn reviewer login off, unset `REVIEWER_LOGIN_ENABLED` and restart `gbk-composer`; the link then disappears and the endpoints return 404. Failed attempts are limited to 5 per IP every 15 minutes.

### Domain verification

OpenAI's portal shows a challenge token. The server returns it as plain text at
`https://compose.grepawk.com/.well-known/openai-apps-challenge` (the route returns 404 until the token is set).
Steps for the owner:
1. In the portal (Connect MCP server), copy the exact token.
2. On the server: add `OPENAI_APPS_CHALLENGE=<token>` to `/etc/gbk-composer.env` (keep mode 600) and run `systemctl restart gbk-composer`.
3. Check: `curl https://compose.grepawk.com/.well-known/openai-apps-challenge` prints exactly the token. Then click Verify Domain.

### Screenshots and demo recording

These are produced by `GBK_NODE22="npx -y node@22" npx playwright test --config test/e2e/submission.config.ts` against a local stack (the real server and workstation, a test account, and a deterministic test model), so nothing is written to the public gallery:
- `starter-1-baroque-fugue.png`, `starter-2-jazz-walking-bass.png`, `starter-3-octave-crescendo.png`: one per starter prompt, 706×860 PNG, showing the in-chat player after the same tool calls ChatGPT makes. Each was rendered by pressing Render in the player (the Done state is shown).
- `gbk-composer-demo.mp4` (about 41 s, 1280×800): a Studio session going from the compose prompt to the live piano roll, the in-browser WAV render, the private-save dialog, and playback.

Demo recording (`review.demo_recording_url`): https://yishengjiang99.github.io/gbk/submission/gbk-composer-demo.mp4. The video and screenshots are in `public/submission/`, so they ship with the GitHub Pages build.

## Privacy and data retention

- **What is stored.** Compositions a user creates through the plugin —
  the structured project data (notes, tracks, sections, controller
  automation, instrumentation, titles, and metadata), their revision
  history, and the rendered artifacts (WAV/MIDI files) produced from them —
  are stored server-side, associated with that user's GBK account, or, for
  account-free use, with no account or name at all (only a random project
  key, of which the server keeps no recoverable copy).
- **Private by default.** A composition is private to its owner. Creating,
  editing, or rendering a composition never publishes it. A composition
  becomes public only when the user explicitly invokes the publish/share
  operation.
- **Access control.** Private compositions and artifacts are accessible
  only to their authenticated owner, or for account-free projects to the
  holder of that project's access key (a composition id alone grants
  nothing; the read-only key cannot edit). Studio links carry only the
  read-only key, inside the URL fragment. Artifact downloads are served through
  authorized, expiring URLs, and authorization is checked again when the
  file is downloaded — not only when the URL is issued. Artifact URLs
  should be treated as short-lived credentials and not shared.
- **Authentication data.** OAuth tokens are validated per request and are
  not stored in project data or embedded in project URLs. The plugin does
  not receive or store the user's ChatGPT credentials.
- **No sale of data.** Composition and account data is not sold. Data is
  used to provide the composition, rendering, and storage features the
  user invoked.
- **Retention.** Compositions and revisions are retained while the user's
  GBK account exists, or for account-free projects until deletion is
  requested, so that follow-up edits remain possible. Rendered artifacts
  (WAV/MIDI) are deleted automatically after 30 days.
- **Lost keys / claim.** An account-free project can only be opened with its
  access key; a lost key cannot be recovered. While the key is held, a
  signed-in user can claim the project into their GBK account
  (`gbk_claim_composition`), after which the account is the recovery path.
- **Deletion.** A user can delete a composition (and its rendered
  artifacts) from GBK Studio, or request deletion of their account data by
  contacting the developer through https://compose.grepawk.com/support.
  Account-free projects can be deleted by the key holder with
  `gbk_delete_composition` (edit key required), or on request through support by
  composition id (the key is confirmed privately, never posted). Deletion
  removes the project data and its artifacts from primary storage.
- **Audio rendering.** WAV is rendered in the user's browser (in-chat
  player or GBK Studio) or, for clients without a browser such as Codex, on
  GBK's own server with the same SoundFont engine. No third-party audio or AI
  service receives the composition. Server-rendered WAV and MIDI files are
  stored with the composition and downloaded through private, expiring links.
- **Model-provider note.** Requests from ChatGPT run GBK's deterministic
  composition engine; they do not invoke GBK's
  website LLM agent, so no additional model-provider processing of the
  composition is introduced by a render.

## Manual steps — human account owner only

These steps cannot be completed by preparing this repository. Each requires
the human account owner (or a human with the relevant account access):

- [ ] **Deploy the server.** Deploy the release containing the `/mcp`
      endpoint (account-free) and optional OAuth endpoints to
      `compose.grepawk.com`, and verify `https://compose.grepawk.com/mcp`
      answers an MCP `initialize` request.
- [x] Icon supplied (`assets/icon.png`); screenshots still optional. Supply real brand assets (logo/icon/screenshots), if the target
      directory requires them, and reference them in `plugin.json`.
- [ ] **Add the custom MCP server in ChatGPT.** In the owner's ChatGPT
      account: Plugins → add custom MCP server → URL
      `https://compose.grepawk.com/mcp`.
- [ ] **Verify no-auth access.** Connect with no authentication; create,
      edit, download MIDI and play in the in-chat player without signing in.
      Confirm another connection cannot open the project by id alone.
- [ ] **(Optional) OAuth linking.** Sign in to GBK in the OAuth flow and
      confirm a test composition appears under that account in GBK Studio.
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
