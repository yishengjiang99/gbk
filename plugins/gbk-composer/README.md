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
| `mcp.json` | Remote MCP server declaration: `gbk_composer`, Streamable HTTP, no sign-in. |
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
**GBK Plugins**. Installation policy is `AVAILABLE`; no GBK account linking
is required.

### As a custom MCP server in ChatGPT

1. Deploy (or use the deployed) GBK server so `https://compose.grepawk.com/mcp`
   answers MCP requests.
2. In ChatGPT, open **Plugins** and add a custom MCP server.
3. Enter the server URL: `https://compose.grepawk.com/mcp`
4. Choose no authentication; create a guest composition without signing in.
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
| `gbk_list_compositions` | List account compositions, or a single capability-authorized guest project. |
| `gbk_edit_composition` | Revision-safe typed edits (parts, notes, orchestration, CC curves, mix, tempo, sections). |
| `gbk_render_composition` | Render a saved revision to WAV (and optionally MIDI). |
| `gbk_get_render_status` | Poll a render job; returns validation data and artifact references. |
| `gbk_get_artifacts` | Authorized, expiring download URLs for WAV/MIDI artifacts. |
| `gbk_open_workstation` | Private read-only deep link that opens the exact project in GBK Studio. |
| `gbk_publish_composition` | Publish a composition publicly — only on the user's explicit request. |
| `gbk_show_composition_ui` | Show the interactive player and piano-roll component in ChatGPT. |

## Account-free access

`mcp.json` declares `extensions["com.openai"].auth.type = "none"`.
Creation returns a composition ID plus independent edit and read capabilities.
Pass the edit capability as `accessToken` on all follow-up tools, including job
status and cancellation. It survives transport reconnects and server restarts
as long as the project and server signing secret remain intact. An ID alone
never grants access. Keep the edit secret private and save it for later edits;
there is no account-based recovery for a lost guest secret.

Studio links carry only the read capability in a URL fragment, and do not sign
the visitor in. Public publish URLs contain no capability. Guest compositions
remain private until explicitly published. Download URLs expire after 15 minutes
by default; request fresh URLs with `gbk_get_artifacts`. Audio bytes expire after
30 days by default; render again when needed. OAuth and website sessions remain
optional for existing account-owned projects.

Guest defaults: 120 seconds (including render tail), 64 generated bars, 20,000
notes/controllers, 100 revisions, 10 renders per project/day. Global guest
budgets, a bounded render queue, storage caps and artifact cleanup prevent new
sessions/projects from bypassing all resource limits. See
`deploy/compose.env.example` and `docs/chatgpt-plugin.md` for configuration.

## Notes

- Useful for classical composition, algorithmic counterpoint and fugues,
  game soundtracks, film cues, ambient music, MIDI orchestration, and
  music programming experiments.
- The WAV render is the authoritative audio. MIDI export preserves notes,
  tempo/meter maps, program changes, and CC automation; SoundFont-specific
  voice overrides and effects render into the WAV only.
- Submission and privacy details for a public listing live in
  `docs/chatgpt-plugin-submission.md` in this repository.
