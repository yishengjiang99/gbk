# GBK WebMCP tools

GBK exposes its workstation to in-browser agents via the WebMCP **imperative API**
(`document.modelContext.registerTool`, falling back to `navigator.modelContext`). There is no HTTP/SSE MCP server,
no cross-origin exposure (`exposedTo` is never set), and no arbitrary JS/DOM/filesystem/network tool.

- Off by default. Toggle **Enable Agent Tools** in the workstation header; a status pill shows `WebMCP: on / off / unavailable`.
- Feature detected; GBK works fully without WebMCP.
- Registration is a module-level singleton bound to one `AbortController`; re-render/HMR re-registration aborts the old set first.
- `execute(input, {signal})` honors cancellation and always reads live `WorkstationController` state.
- Every tool returns JSON text: `{ ok, projectId, revision, data, warnings }` or `{ ok:false, error:{code,message} }`.
  Codes: `STALE_REVISION, INVALID_RANGE, INVALID_ARGUMENT, UNSUPPORTED_CC, AUDIO_NOT_READY, USER_APPROVAL_REQUIRED, OPERATION_CANCELLED`.
- Read tools carry `readOnlyHint: true` and `untrustedContentHint: true` (track names/metadata come from files).

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

## Testing in Chrome
Launch Chrome with `--enable-features=WebMCPTesting` (or the WebMCP origin trial) and use the
[Model Context Tool Inspector / webmcp-extension](https://github.com/GoogleChromeLabs/webmcp-extension), or
`await document.modelContext.getTools()` / `executeTool()` from the console.
