# ChatGPT acceptance (#72 Phase 2)

What has been verified, how, and what only the owner can verify in real ChatGPT. **No result here comes from real
ChatGPT.** The automated parts use a scripted MCP client (`scripts/acceptance/mcp-acceptance.ts`) and a simulated
MCP Apps host in Playwright (`test/e2e/widget-sandbox.check.ts`).

## Harnesses

| Harness | Covers | Run |
| --- | --- | --- |
| `scripts/acceptance/mcp-acceptance.ts` | A, B, C (capability parts), E | `node --import tsx/esm scripts/acceptance/mcp-acceptance.ts https://compose.grepawk.com`. Creates private guest projects and deletes them at the end with their edit keys. Prints no tokens. |
| `server/test/launch-acceptance.test.ts` | The same harness against a local server, in CI | `npm run test:server` |
| `test/e2e/widget-sandbox.check.ts` | D: in-chat player in a cross-origin sandboxed iframe with a CSP built from the declared domains | `node --import tsx/esm test/e2e/widget-sandbox.check.ts all` (`chromium`, `webkit`, `webkit-iphone`) |

## Results (2026-10-24, about 19:25 PT)

| Scenario / env | Actual result | Evidence | Auto / manual | Defects | Launch blocker |
| --- | --- | --- | --- | --- | --- |
| A first use: 16-bar baroque fugue in D minor, 4 organs, private, player, server WAV + MIDI, download, validate. **Production** | 14/14 checks pass. Private; 4 tracks; WAV 44.1k/stereo/PCM16, 38.6 s, non-silent, sha256 + size match; SMF format 1, 5 tracks | `evidence/acceptance-prod-2026-10-24.txt` | Auto | none | no |
| B revision continuity: 24-bar jazz, walking bass, bass doubled -12 in bars 9-16, CC11 crescendo, re-render. **Production** | All pass. `untouchedSectionsUnchanged: true`; notes starting in bars 1-8 and 17-24 identical before/after; stale revision rejected; the re-rendered job's revision is the new one (4) | same | Auto | Observation: `generate_part walking_bass` over the existing bass adds a second line (two notes at tick 0, pitch 33) rather than replacing it. This is by design per the edit semantics but can sound doubled. | no |
| C session recovery: new session + retained token, lost token, read-only key, cross-project. **Production** | All pass. Id alone → NOT_FOUND; read key → INSUFFICIENT_SCOPE for edit/publish/delete; another project's token → NOT_FOUND; nothing published | same | Auto | none | no |
| C claim into account | Covered locally with test OAuth (`mcp-guest.test.ts`, "claim moves a project"); not run in production (needs a real sign-in) | test | Auto (local) + manual | none | no |
| C does ChatGPT keep `accessToken` across turns / new chats? | **Unverified.** GBK does not assume it does. A new chat has no project unless the user pastes the id and key or the project was claimed. | — | Manual (owner) | — | no |
| D desktop Chromium, strict CSP + reference-host CSP | Render 2 s, plays (AudioContext running), WAV link, Stop works, 0 CSP violations. The undeclared-domain control fails as expected, which shows the CSP is enforced. | `evidence/widget-browsers-2026-10-24.json` | Auto | none | no |
| D desktop WebKit | Same as Chromium | same | Auto | none | no |
| D iPhone-size WebKit (iPhone 13 viewport/UA/touch) | Same as Chromium. This is not a real iPhone. | same | Auto | none | no |
| D memory use, long pieces | Not measured | — | Manual | — | no |
| D real ChatGPT (web, iOS, Android) | **Unverified** | — | Manual (owner) | — | no (review risk) |
| E malformed args | Rejected, no project created | prod log | Auto | Error code surfaces as a generic tool error (zod validation), not `INVALID_ARGUMENT` | no |
| E unknown SoundFont | `INVALID_ARGUMENT` before any job starts | prod log | Auto | none | no |
| E tampered/expired download link | HTTP 401 | prod log | Auto | none | no |
| E cancel | `cancelled`, 0 artifacts | prod log | Auto | **Fixed in PR B:** a worker respawned after a cancel was not stopped on shutdown, which kept the process alive. The harness found it. | no |
| E quota / timeout / worker crash | Covered locally (`mcp-guest.test.ts` caps, `mcp-server-render.test.ts` duration/rate limits; worker exit → `RENDER_FAILED`, no artifact) | tests | Auto (local) | none | no |
| E disconnect mid-render (client) | The job is durable server-side; poll with `gbk_get_render_status` | code | Manual in ChatGPT | — | no |

## Manual checklist for the owner (real ChatGPT)

Do each in a **new chat** with GBK connected (No authentication). Record pass/fail plus a screenshot that shows no tokens.

1. Starter prompt 1 → piano roll appears in the chat (widget renders in real ChatGPT).
2. Starter prompt 2 → press **Render** in the player → progress, Play, WAV + MIDI download.
3. Starter prompt 3 → the CC11 lane shows a crescendo in bars 9-16.
4. "Give me download links for the WAV and MIDI": links download and play on desktop.
5. In the same chat, ask to edit again. Does ChatGPT still pass the `accessToken`? (Expected yes in the same chat.)
6. New chat: "open my last GBK piece". Expect GBK to say it cannot find it without the key or sign-in, and not to make anything up.
7. iPhone ChatGPT app: steps 1-2 (AudioWorklet and download behavior on iOS).
8. Negative cases: lyrics, "delete all", weather. No false claims.
9. Optional: sign in with the reviewer account and claim a piece.
