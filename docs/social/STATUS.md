# gbk Social status

## iOS

Native SwiftUI client in `ios/` (XcodeGen, iOS 17). CI: `.github/workflows/ios.yml` (macOS, simulator build + unit tests, unsigned).

| Area | State |
|---|---|
| M0 scaffold (tabs, theme, API client, Keychain auth store, push manager, feed player, deep links, studio web view) | done |
| Feed: `GET /api/feed` cursor paging, For you/New/Top chips, label menu, tag filter, `/t/<tag>` deep link | done (live API) |
| Feed song switch: next song starts immediately at full volume; only the old one fades out over 150 ms (cos curve), on scroll settle (Yisheng, 2026-10-25; web contract still says 400 ms equal-power) | done |
| Feed card visuals: row 1 windowed piano roll (playhead 25%, 4 s window = 1 s behind / 3 s ahead, finished notes vanish, active notes brightened 45% + glow, black-key row stripes, loops); row 2 48 log-spaced spectrum bars (40 Hz–16 kHz, instant attack, 150 ms decay) + oscilloscope, both from one MTAudioProcessingTap; TimelineView(.animation)+Canvas, active card only, paused with audio | done (constants from web LiveRoll.tsx; device run unverified) |
| Dark Mode: all colours in asset colour sets with light/dark variants, no hard-coded white/black; previews + light/dark snapshot tests uploaded as the `ios-snapshots` CI artifact | done (dark palette defined on iOS; web has no dark palette yet) |
| Background audio policy: the feed pauses when the app goes to the background (decided) | done |
| Play counting `POST /api/shares/:slug/play` | done (live API) |
| Ratings (stars, tap again to clear, double-tap = 5) | done (live API) |
| Comments sheet (flat, post, delete own, report) | done (live API) |
| Report sheet `POST /api/reports` | done (live API) |
| Block `POST /api/blocks/:handle` | wired; route is P4, shows "not available" on 404 |
| Profile: `GET /api/me` + `GET /api/users/:handle` | done (live API; `/api/me` needs a token) |
| Native auth (Apple/Google exchange, refresh, logout), web-code handoff, `DELETE /api/me`, push register | behind `AuthServicing`: `LiveAuthService` calls the specced routes; `MockAuthService` for tests. Routes 404 on prod today |
| sf2player-swift `SF2Engine` dependency | added (pinned 6ce4941), not used yet |
| Reviewer sign-in (App Review): native form → `/signin/reviewer` CSRF + `POST /api/auth/reviewer`, `gbk_cs` stored as Bearer | done (live route; verified to reach the password check from Linux) |
| Inbox/DMs | placeholder (P4) |
| Signing | `DEVELOPMENT_TEAM` 83D36RPMUM in project.yml; CI builds with `CODE_SIGNING_ALLOWED=NO` |
| App icon | approved by Yisheng (light-blue gradient, #2d6a93 note); keep as is |
| Release | `.github/workflows/ios-release.yml`: manual TestFlight, automatic signing via ASC API key (`-allowProvisioningUpdates`), no p12/profile; build number = run_number; `ITSAppUsesNonExemptEncryption=NO`. Bundle switched to `com.grepawk.moviefone` (2026-10-25, Yisheng's call) to match ASC app 6826906431. Blocked: ASC issuer ID not found on the box, so the key can't authenticate and `APP_STORE_CONNECT_ISSUER_ID` isn't set |
| App Store listing | `docs/asc/`: metadata (name, subtitle, description, keywords, URLs), privacy label, content rights, age rating, review notes (reviewer login), 2 x 6.9" screenshots from mockups. compose.grepawk.com /privacy, /support, /terms all 200. Bundle ID is com.grepawk.moviefone (matches the ASC record); com.grepawk.gbk no longer used |
| CI | `ios.yml` (simulator build + tests, light/dark snapshots as `ios-snapshots` artifact) green on b752fff: https://github.com/yishengjiang99/gbk/actions/runs/40225529455 |

### Doc vs prod (checked 2026-10-25 against prod 44b3be2)

- `preview`: prod sends `{ tracks: [color], lo, hi, end, notes: [[trackIndex, start, length, pitch]] }`; the doc says `{ notes: [[pitch, start, dur, track]], duration }`. The iOS model accepts both.
- `GET /api/session` returns `{ authenticated, user, name, provider, csrf, enabled, providers, loginAvailable, reviewerLogin, limits }`, not `{ user, csrf, me }`.
- 404s for unbuilt routes use Fastify's `{ message, error, statusCode }`, not `{ code, message }`.
- `/t/<tag>` is a tag deep link (the M0 app treated it as a thread; fixed).

### Feed visuals vs web (2026-10-25)

Mirrors `src/components/social/LiveRoll.tsx`: PLAYHEAD_X 0.25, WINDOW_SEC 4, BARS 48, BAR_DECAY_MS 150, F_LO 40 / F_HI 16000, bar hue 200→340°, active note `brighten(0.45)` + glow, inactive alpha 0.85, note height 0.85 row, pitch span ≥ 12.
Differences: iOS hides notes once they finish (per the iOS card spec), while web LiveRoll still draws them in the 1 s left of the playhead. iOS also adds the Export video's black-key row stripes. The Export video itself uses an 8 s window with the playhead at 30%; the feed cards use the LiveRoll values. Bars are scaled from dB like the AnalyserNode defaults (-100…-30 dB). The oscilloscope is iOS only for now.
