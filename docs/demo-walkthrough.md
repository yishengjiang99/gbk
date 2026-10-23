# Demo walkthrough (agent + human)

Automated as `test/e2e/workstation-webmcp.spec.ts` (`npx playwright test --project=chrome-webmcp`, needs Google Chrome;
the project launches it with `--enable-features=WebMCPTesting`). Screenshots go to `$GBK_SHOTS` (default /workspace/shots).

1. Open GBK. The workstation is the main view; **Player / Library** opens the original player in a modal.
2. In the player, pick *Habanera*; close the modal. The workstation mirrors the song (tracks, notes, CCs).
3. Tick **Enable Agent Tools** → pill shows *WebMCP on*; `document.modelContext.getTools()` lists 26 `gbk_*` tools.
4. Agent: `gbk_list_tracks`, `gbk_select_passage {bars 9–16}`, `gbk_generate_cc_curve {CC11 crescendo}` → dashed green
   overlay in the CC11 lane; `gbk_generate_cc_curve {CC1 swell}` then `gbk_discard_proposal` (revision unchanged).
5. Agent: `gbk_commit_proposal` → GBK shows "Agent asks to commit"; the user presses **Accept** → one undo step.
6. Agent: `gbk_set_track_mix {pan}`; `gbk_generate_counterpoint {below, alto register, seed 42}` → proposed notes overlay;
   `gbk_preview_proposal A` / `B` auditions; commit (user Accept); `gbk_undo` / `gbk_redo`.
7. `gbk_prepare_midi_export` → .mid download; re-parsed: CC11 points and the new track survive.
8. `gbk_prepare_wav_export` → offline SF2 render with the same automation.
9. Reload → the edited project (same revision) is restored from IndexedDB; agent tools re-register.
