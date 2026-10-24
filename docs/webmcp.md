# GBK WebMCP tools

GBK exposes its workstation to in-browser agents via the WebMCP **imperative API**
(`document.modelContext.registerTool`, falling back to `navigator.modelContext`). In the browser there is
no cross-origin exposure (`exposedTo` is never set), and no arbitrary JS/DOM/filesystem/network tool.

> **Remote MCP (ChatGPT / Codex):** the same canonical registry now also powers a server-side
> Streamable-HTTP MCP endpoint at `https://compose.grepawk.com/mcp` with durable compositions,
> OAuth 2.1, autonomous worker-thread rendering and an MCP Apps player — see
> [chatgpt-plugin.md](chatgpt-plugin.md). The browser WebMCP surface described here is unchanged.

- Toggle **Enable Agent Tools** in the workstation header; the status pill shows `WebMCP on/off` (real API) or
  `Agent tools (shim: window.gbkTools) on/off` (fallback). With the real API it is off by default; in shim mode it is
  on by default (the shim is page-local) unless the user unchecked it (persisted in `localStorage["gbk.agentTools"]`).
- Feature detected; GBK works fully without WebMCP. See **Modes** below.
- Registration is a module-level singleton bound to one `AbortController`; re-render/HMR re-registration aborts the old set first.
- `execute(input, {signal})` honors cancellation and always reads live `WorkstationController` state.
- Every tool returns JSON text: `{ ok, projectId, revision, data, warnings }` or `{ ok:false, error:{code,message} }`.
  Codes: `STALE_REVISION, INVALID_RANGE, INVALID_ARGUMENT, UNSUPPORTED, AUDIO_NOT_READY, USER_APPROVAL_REQUIRED, OPERATION_CANCELLED`.
- Read tools carry `readOnlyHint: true` and `untrustedContentHint: true` (track names/metadata come from files).

## Modes: real WebMCP, origin trial, in-page shim
| Browser | `document.modelContext` | How an agent calls tools |
| --- | --- | --- |
| Chrome with `--enable-features=WebMCPTesting` | yes | WebMCP host/extension, or `document.modelContext.executeTool` |
| Chrome on an origin with a valid WebMCP origin-trial token | yes | same as above, no launch flags |
| Any other browser (normal Chrome, no flags) | no | **shim**: `await gbkTools.call(name, args)` from the page (CDP / Playwright `page.evaluate`, DevTools console, a desktop agent's browser) |

`window.gbkTools` is installed in both modes once agent tools are enabled (in real-WebMCP mode the toggle starts off, so it appears after the user enables it) and is backed by the same registry:
- `gbkTools.mode` → `"webmcp"` or `"shim"`
- `await gbkTools.list()` → `[{name, description, inputSchema, annotations}]` (47 `gbk_*` tools; empty while the toggle is off)
- `await gbkTools.call(name, args)` → exactly what the real tool's `execute()` returns (the JSON-string envelope;
  `JSON.parse` it). Unknown/unregistered names reject.

When the real API exists the adapter registers on it **and** on the local registry; it never replaces or polyfills
`document.modelContext`, so WebMCP feature detection by other code stays honest. Example (no flags):
```js
const r = JSON.parse(await page.evaluate(() => gbkTools.call("gbk_create_project", { name: "Demo", tempo: 100, replaceCurrent: true })));
```
E2E: `GBK_SHIM=1 npx playwright test --project=chrome-shim-autonomous` (Chrome stable, no launch flags).

### Origin trial (real WebMCP without flags)
No token is committed: tokens are bound to one origin and must be registered by the site owner.
1. Open <https://developer.chrome.com/origintrials>, find the **WebMCP** trial, click *Register*.
2. Web origin: `https://yishengjiang99.github.io` (GitHub Pages serves `/gbk/` from that origin). Leave third-party
   matching off. Accept the terms and copy the token. (Optionally register `http://localhost:5173` for dev.)
3. CI: add a repository **variable** (or secret) `GBK_WEBMCP_ORIGIN_TRIAL_TOKEN` (Settings → Secrets and variables →
   Actions). `deploy.yml` passes it to `npm run build`. Tokens are public by design (they ship in the HTML), so a variable is fine.
4. Local: `GBK_WEBMCP_ORIGIN_TRIAL_TOKEN=... npm run build`, or put `{"token": "..."}` in the gitignored
   `webmcp-origin-trial.local.json`. Multiple tokens may be comma-separated.
5. The Vite plugin in `vite.config.ts` injects `<meta http-equiv="origin-trial" content="…">` into each HTML entry.
   Verify: view source of the deployed page, then in Chrome `!!document.modelContext` is `true` and the pill reads `WebMCP`.
6. Tokens expire with the trial; renew on the same page and update the variable. If the token is missing or invalid the
   page silently falls back to the shim.

## Edit model
Agents never mutate directly (except mix/instrument/selection/transport, which are undoable or non-destructive).
Edits are **proposals** (`gbk_propose_*`, `gbk_generate_*`) staged against a `baseRevision`; the UI overlays them.
`gbk_preview_proposal` auditions A/B; `gbk_commit_proposal` asks the user to press **Accept** (one undo step);
otherwise returns `USER_APPROVAL_REQUIRED`. `gbk_undo`/`gbk_redo` share the human history.

## Coordinates
`{unit: "bars"|"beats"|"ticks"|"seconds", start, end}`. Bars are 1-based and the end bar is inclusive.
Ticks use the file PPQ; seconds follow the tempo map; bars follow the meter map.

## Tools
Read: `gbk_get_capabilities, gbk_get_project_summary, gbk_list_tracks, gbk_get_notes, gbk_get_cc_events,
gbk_get_selection, gbk_get_transport, gbk_list_presets, gbk_analyze_passage`.
Transport/mix: `gbk_set_transport, gbk_set_track_mix, gbk_set_instrument, gbk_select_passage`.
Edit: `gbk_propose_note_patch, gbk_propose_cc_patch, gbk_generate_cc_curve, gbk_propose_track_patch,
gbk_preview_proposal, gbk_commit_proposal, gbk_discard_proposal, gbk_undo, gbk_redo`.
Music: `gbk_generate_counterpoint, gbk_generate_fugue_section`. Export: `gbk_prepare_midi_export, gbk_prepare_wav_export`
(browser-local downloads only).
Sound: `gbk_get_voice_settings` (read), `gbk_propose_voice_patch`, `gbk_set_effects` (both proposals). See
[sound-design.md](sound-design.md).

### Sound design tools
- `gbk_get_voice_settings {trackId, key?=60, velocity?=100}` → the track's resolved preset and, per matching zone,
  every editable generator as `{gen, native, zone, value, unit, overridden}` with `value` in human units
  (seconds, Hz, dB, cents, %), plus `effectiveSends.reverb|chorus = {zonePercent, ccModulatorPercent,
  overridePercent, effectivePercent}` (zone gen 16/15 + CC91/93 modulator at the playhead + override, clamped 0–100 %),
  the track's override list and the global effects. Zones need a loaded SoundFont (otherwise a warning).
- `gbk_propose_voice_patch {trackId, edits:[{param, mode, value, keyLo?, keyHi?}], replace?, summary?, baseRevision?}`.
  `mode`: `set` = absolute in the param's unit (validated against the SF2 2.01 §8.1.3 range, e.g.
  `volEnvRelease` 0.001–100 s), `add` = delta for dB/cents/%/semitone params, `scale` = factor for seconds/Hz params.
  Returns a proposal (range = first ~8 s of the track for A/B); the Sound panel shows the B envelope dashed plus a diff list.
- `gbk_set_effects {enabled?, roomSize?, damping?, reverbLevel?, chorusLevel?, chorusDepthMs?, chorusRateHz?, chorusDelayMs?}`
  → proposal. `enabled:false` is the off switch.
- `gbk_get_capabilities` now reports `controllers[91|93].audible = true`, `effects`, and `voiceEditing`.

Example agent flow: `gbk_get_voice_settings` → `gbk_propose_voice_patch {edits:[{param:"volEnvRelease",mode:"set",value:3},
{param:"reverbSend",mode:"set",value:60}]}` → `gbk_preview_proposal` A then B → `gbk_commit_proposal` (user presses Accept).

## Autonomous composition and headless rendering

Requires the user's existing opt-in (**Enable Agent Tools**). No other clicks, Player use, SoundFont upload or audio
unlock are needed: rendering is fully offline (`src/audio/offline-renderer.ts`) and fetches the bundled SoundFont
from the Vite base (`/gbk/static/GeneralUser-GS.sf2`) when the player has not loaded one.

### Project primitives
| Tool | Purpose |
| --- | --- |
| `gbk_create_project` | New agent-owned project `{name, tempo, timeSignature, key, ppq, replaceCurrent}`. The previous project is checkpointed to IndexedDB unless `replaceCurrent`. Starts a **scoped autonomous session**. |
| `gbk_create_track` | One track or `{tracks:[…]}` batch with `role` (melody/harmony/bass/accompaniment/percussion/pad/other), program, bank, mix. Percussion is assigned channel 10 / bank 128. |
| `gbk_set_tempo_map`, `gbk_set_time_signature_map` | Bar-based maps, validated (bpm 20–400, denominators powers of two). |
| `gbk_set_song_structure` | Non-overlapping named sections with `energy` (0–1); exported as SMF markers, drawn as bands in the piano roll. |
| `gbk_get_composition_session` | Session state (project id, base revision, expiry). |

**Autonomous session.** Edits to the agent-created project commit without the Accept dialog, but only while the
session's project is loaded. It ends when the user loads another song, after 2 h, or from the Agent panel
(**End session**). **Discard agent work** undoes everything back to the session's base revision. Edits to
user-owned projects still go through proposals and Accept.

### Composition
| Tool | Purpose |
| --- | --- |
| `gbk_generate_arrangement` | Seeded, deterministic full arrangement (`style`: baroque/classical/pop/jazz/ambient; `key`, `tempo`, `bars`, `seed`, `voices`, `complexity`, `instrumentation`, `features`). Writes notes, CC11 phrase dynamics per section energy, CC1 for sustained instruments, CC91. Returns voice-leading metrics. |
| `gbk_generate_part` | melody, bass, walking_bass, chords, arpeggio, alberti, drums or counterpoint for one track and bar range. |
| `gbk_transform_notes` | quantize, humanize, articulate (staccato/legato/accent), phrase dynamics, variation. |
| `gbk_orchestrate` | Double a passage onto another track with transposition and velocity scale, folded into the target instrument's range. |

### Rendering and artifacts
| Tool | Purpose |
| --- | --- |
| `gbk_render_wav` | `{sampleRate: 44100|48000, channels: 1|2, format: pcm16|float32, tailSeconds, normalize: loudness|peak|off (default loudness), targetLufs, autoPan (default false; never overrides an explicit pan), range, includeMidi, output: "artifact"|"audio"|"bytes", download:false, waitSeconds}`. Never downloads unless `download:true`. Returns job id, status, artifact id, size, SHA-256, duration, peak/RMS, clipping, `loudness` (input/output LUFS, true peak, gain, limiter), instruments (incl. substitutions, pan, pinned preset) and warnings. |
| `gbk_get_render_status`, `gbk_cancel_render` | Poll / cancel a job (queued → loading → rendering → encoding → validating → saving → completed). |
| `gbk_list_render_artifacts`, `gbk_get_render_artifact` | IndexedDB-persisted WAV/MIDI artifacts (survive reload). |
| `gbk_read_wav_bytes` | `{artifactId, offset, length ≤ 262144}` → base64 chunk, `nextOffset`, `eof`, total size and SHA-256. Use it to pull a full WAV into the agent; verify by SHA-256. |
| `gbk_download_render_artifact`, `gbk_delete_render_artifact` | Explicit browser download / removal. |

**Output modes.** `artifact` (default) stores the file and returns metadata. `audio` returns MCP `audio` content
only if the host advertises it (`modelContext.supportedContentTypes` or `globalThis.gbkWebMcpContentTypes`) and the
file is ≤ 4 MB; otherwise it falls back to an artifact and says why in `warnings`. `bytes` returns base64 inline up to
256 KiB; larger files fall back to the artifact with `bytesInline:false` and a `reason` pointing at `gbk_read_wav_bytes`. Nothing is ever truncated silently.
Chrome's WebMCPTesting build currently stringifies tool results, so the adapter emits text only by default.

**Errors** (`error.code`): `SOUNDFONT_FETCH_FAILED`, `SOUNDFONT_INVALID`, `INSTRUMENT_NOT_FOUND`, `EMPTY_PROJECT`,
`RENDER_TOO_LARGE`, `OPERATION_CANCELLED`, `NON_FINITE_SAMPLES`, `WAV_INVALID`, `UNEXPECTED_SILENCE`,
`UNEXPECTED_CLIPPING`, `QUOTA_EXCEEDED`, `STORAGE_UNAVAILABLE`, `ARTIFACT_NOT_FOUND`, `DOWNLOAD_BLOCKED`,
`INVALID_ARGUMENT`, `INTERNAL_ERROR`.

### Example (Midnight Invention)
```
gbk_create_project {name:"Midnight Invention", tempo:108, timeSignature:[4,4], key:"C minor"}
gbk_create_track ×4 (violin 40, viola 41, cello 42, harpsichord 6)
gbk_set_song_structure {sections:[Introduction 1–4, Theme 5–16, Development 17–28, Coda 29–32]}
gbk_generate_arrangement {style:"baroque", bars:32, seed:12345, voices:4}
gbk_render_wav {output:"artifact", download:false}
gbk_read_wav_bytes {artifactId, offset:0, length:262144} … until eof; check sha256
```
E2E: `PW_BASE_URL=http://127.0.0.1:5173/gbk/ npx playwright test --project=chrome-webmcp-autonomous`
(Chrome with `--enable-features=WebMCPTesting`, no autoplay flag, clean profile).

## Testing in Chrome
Launch Chrome with `--enable-features=WebMCPTesting` (or the WebMCP origin trial, or use the shim above) and use the
[Model Context Tool Inspector / webmcp-extension](https://github.com/GoogleChromeLabs/webmcp-extension), or
`await document.modelContext.getTools()` / `executeTool()` from the console.
