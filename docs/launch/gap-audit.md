# Launch gap audit (#72): what the repo says vs. what it does

Audited 2026-10-24 against `main` at `5e35c33` (after #94 plus the direct SoundFont commit).
The implementation is the source of truth. `server/test/launch-consistency.test.ts` keeps the docs in line with it.

**Submission status: UPLOADED only.** The owner uploaded a plugin ZIP to the OpenAI portal. It has not been
confirmed as submitted, and it is not approved, published, or listed. See [portal-package-delta.md](portal-package-delta.md).

## Live tool registry (17)

`server/src/mcp/server.ts`: `gbk_get_capabilities`, `gbk_list_soundfonts` (added in 5e35c33, after the upload),
`gbk_create_composition`, `gbk_get_composition`, `gbk_list_compositions`, `gbk_edit_composition`,
`gbk_render_composition`, `gbk_get_render_status`, `gbk_cancel_render`, `gbk_get_artifacts`, `gbk_open_workstation`,
`gbk_publish_composition`, `gbk_delete_composition`, `gbk_claim_composition`, `gbk_show_composition_ui`, and the
app-only `gbk_widget_render_start` / `gbk_widget_render_finish`. The owner brief says "16 tools"; that count was
correct before `gbk_list_soundfonts` was added.

## Status by #72 area

| Area | Status | Evidence / note |
| --- | --- | --- |
| Remote MCP (streamable HTTP, `/mcp`) | Complete | `server/src/mcp/routes.ts`, `server/test/mcp-protocol.test.ts` |
| Account-free composition (per-project capabilities) | Complete | #88, `guest.ts`, `mcp-guest.test.ts` |
| Optional OAuth (PKCE, scopes) and reviewer login | Complete | `oauth.ts`, `mcp-oauth.test.ts`, #86 `reviewer-login.test.ts` |
| Private project access, read key cannot edit or publish | Complete | `mcp-guest.test.ts` |
| Claim a guest composition into an account | Complete | `gbk_claim_composition`. **The terms page used to deny this; fixed in PR A.** |
| Delete (one guest composition, edit key) | Complete | `gbk_delete_composition`. **The submission packet used to say "There is no delete tool"; fixed in PR A** (plugin.json was already fixed in #94). |
| In-chat player render (browser, AudioWorklet/OfflineAudioContext) | Complete, unverified in real ChatGPT | #89, `ui.ts`, `browser-render.ts`. Verified with tests and a simulated host only. |
| Headless server render (worker thread) | Complete | #91-#93, `server-render.ts`, `render-worker.ts`, `mcp-server-render.test.ts`; the deploy tarball ships `render-worker.mjs` |
| SoundFont selection | Complete (server-only change, not in the uploaded ZIP) | `gbk_list_soundfonts`, `mcp-soundfonts.test.ts` |
| MIDI export, WAV validation, revision-safe edits | Complete | `mcp-workflow.test.ts` |
| Listing metadata (Entertainment, short/long description, test cases) | Complete | #94, `mcp-listing.test.ts` |
| Review test cases independent of chat history | Missing, fixed in PR B | Cases 3-5 said "my last piece" / "my jazz piece", which fails in a clean conversation |
| Discovery eval (42 fixtures) + runner | Complete; variance unmeasured | #90; rerun in PR B |
| Funnel analytics (aggregate, server-side) | Partial | #90 `FunnelStore`, `/api/admin/funnel`; install CTA, first tool call, server render completion, and failures are not counted (PR E) |
| `/chatgpt` landing page | Partial | Value prop, starter prompts, account-free text; no gallery examples yet; the install CTA appears only when `CHATGPT_PLUGIN_URL` is set (correct) |
| Demo gallery (6 engine-generated demos) | Missing | PR C |
| Launch docs set (`docs/launch/*`) | Missing | PR F |
| CI: manifest/tool consistency, token-leak, worker smoke | Partial | `test.yml` runs typecheck and tests; extended in PR F |
| Real ChatGPT validation | Unverified | Only Codex, a fake model, and a simulated widget host were used. Owner-only. |
| Starter prompts from the #72 text ("60-second orchestral soundtrack...") | Obsolete by owner decision | #94 kept the three prompts that are tested |
| Subtitle "AI MIDI Music Studio" | Obsolete by owner decision | Short description is "Compose music, export WAV/MIDI" |
| Browser-only rendering design (#88 title) | Obsolete by owner decision | Superseded by #91 server render. Both paths are intentional. |

## Contradictions found and fixed (PR A)

| Where | Was | Now |
| --- | --- | --- |
| `docs/chatgpt-plugin-submission.md` status | "not submitted" | "UPLOADED only", not approved or published |
| Submission packet, negative case 2 | "There is no delete tool" | Single-composition delete with edit key; no bulk delete |
| `/terms` guest section | "we cannot move such a composition to an account" | Claim possible while you hold the key |
| `/support` render help | "rendering runs in your browser" | Server render or in-chat player |
| `docs/compose-deploy.md` | "the server never holds audio" | The website composer renders in the browser; MCP server render is separate |
| `plugins/gbk-composer/README.md` (in the package) | `gbk_render_composition` = "in the user's browser"; 4 tools missing | Server or Studio render; full tool list |
| `gbk_create_composition` description (live) | Rendering = player or "a connected Studio tab" | Also server render |
| `docs/chatgpt-plugin.md` tool list | Missing list_soundfonts, delete, claim, widget tools | Full list |

The root README sections about `gbk_render_wav` and similar tools describe the **in-page WebMCP tools** (a
separate surface). They are correct and were left alone.

## Changes that would need a replacement ZIP

Only `plugins/gbk-composer/**` ships in the ZIP. PR A edits `plugins/gbk-composer/README.md` (documentation only, no
behavior). PR B edits the `review.test_cases` in `plugin.json`. The reviewer reads the same cases from the portal
form, so the owner can paste them there instead of re-uploading. Details: [portal-package-delta.md](portal-package-delta.md).
