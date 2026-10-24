# GBK Composer — plugin package

Compose, edit, orchestrate, visualize, and render MIDI music with a
deterministic SoundFont synthesizer. Generate structured arrangements,
modify individual passages, control expression, and export WAV and MIDI.

This package connects ChatGPT and Codex to the GBK Composer remote MCP
server at `https://compose.grepawk.com/mcp`. Compositions are created and
rendered server-side — no open browser tab is required — and every project
can also be opened in GBK Studio at <https://compose.grepawk.com>.

## Package contents

| Path | Purpose |
| --- | --- |
| `plugin.json` | Portable Agent Plugins manifest (name, description, OpenAI interface metadata, example prompts). |
| `mcp.json` | Remote MCP server declaration: `gbk_composer`, Streamable HTTP, OAuth. |
| `skills/compose-music/SKILL.md` | How to compose a new piece end to end. |
| `skills/edit-music/SKILL.md` | How to make targeted, revision-safe edits. |
| `skills/render-music/SKILL.md` | How to render, verify, and deliver WAV/MIDI. |
| `assets/` | Brand assets. None are bundled yet — see `assets/README.md`. |

## Install

### From this repository's marketplace

This repository ships a local marketplace at
`.agents/plugins/marketplace.json` (`gbk-local`) that lists this plugin:

```text
.agents/plugins/marketplace.json
  └─ gbk-composer → ./plugins/gbk-composer
```

In a client that supports portable Agent Plugins marketplaces, add this
repository as a marketplace source and install **GBK Composer** from
**GBK Plugins**. Installation policy is `AVAILABLE` and authentication is
`ON_INSTALL` — you will be asked to sign in to GBK when the plugin is
installed (see Auth below).

### As a custom MCP server in ChatGPT

1. Deploy (or use the deployed) GBK server so `https://compose.grepawk.com/mcp`
   answers MCP requests.
2. In ChatGPT, open **Plugins** and add a custom MCP server.
3. Enter the server URL: `https://compose.grepawk.com/mcp`
4. Complete the GBK sign-in / account-linking flow (OAuth, see below).
5. Invoke it, for example: "@GBK Compose a 32-bar four-voice Baroque fugue
   in D minor at 108 BPM with organ instrumentation and expressive CC11
   dynamics. Render WAV and MIDI."

The same MCP endpoint can be configured in Codex and other MCP-compatible
clients using the declaration in `mcp.json`.

## Tools

| Tool | What it does |
| --- | --- |
| `gbk_get_capabilities` | Discover styles, instruments, render formats, and limits. |
| `gbk_create_composition` | Create a durable composition project; returns its ID and revision. |
| `gbk_get_composition` | Inspect a composition's sections, tracks, notes, and revision. |
| `gbk_list_compositions` | List the signed-in user's compositions. |
| `gbk_edit_composition` | Revision-safe typed edits (parts, notes, orchestration, CC curves, mix, tempo, sections). |
| `gbk_render_composition` | Render a saved revision to WAV (and optionally MIDI). |
| `gbk_get_render_status` | Poll a render job; returns validation data and artifact references. |
| `gbk_get_artifacts` | Authorized, expiring download URLs for WAV/MIDI artifacts. |
| `gbk_open_workstation` | Authenticated deep link that opens the exact project in GBK Studio. |
| `gbk_publish_composition` | Publish a composition publicly — only on the user's explicit request. |
| `gbk_show_composition_ui` | Show the interactive player and piano-roll component in ChatGPT. |

## Auth summary

- The MCP server is a protected resource. Access uses OAuth 2.0
  authorization code with PKCE, discovered through the standard protected
  resource / authorization server metadata endpoints.
- `mcp.json` declares this as `extensions["com.openai"].auth = { "type": "oauth" }`.
  No static client block is included: the server supports dynamic client
  registration and Client ID Metadata Documents (CIMD), so ChatGPT/Codex
  register or identify themselves at connect time.
- The OAuth flow links the client to the user's existing GBK account (the
  website's invite-code / session account). Tokens are validated for
  issuer, audience, scopes, and expiry on every call.
- Scopes are narrow: compositions read/write, renders create, artifacts
  read, and shares publish are separate permissions.
- Private compositions and artifacts are only accessible to their owner;
  artifact downloads are authorized, expiring URLs checked again at
  download time. Compositions are private by default and are published
  only through an explicit publish action.

## Notes

- Useful for classical composition, algorithmic counterpoint and fugues,
  game soundtracks, film cues, ambient music, MIDI orchestration, and
  music programming experiments.
- The WAV render is the authoritative audio. MIDI export preserves notes,
  tempo/meter maps, program changes, and CC automation; SoundFont-specific
  voice overrides and effects render into the WAV only.
- Submission and privacy details for a public listing live in
  `docs/chatgpt-plugin-submission.md` in this repository.
