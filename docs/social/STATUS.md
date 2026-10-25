# gbk Social status

## iOS

Native SwiftUI client in `ios/` (XcodeGen, iOS 17). CI: `.github/workflows/ios.yml` (macOS, simulator build + unit tests, unsigned).

| Area | State |
|---|---|
| M0 scaffold (tabs, theme, API client, Keychain auth store, push manager, feed player, deep links, studio web view) | done |
| Feed: `GET /api/feed` cursor paging, For you/New/Top chips, label menu, tag filter, `/t/<tag>` deep link | done (live API) |
| Feed song switch: next song starts immediately at full volume; only the old one fades out over exactly 58 ms (cos curve), on scroll settle (Yisheng, 2026-10-25; matches web feed-design.md) | done |
| Web feed audio switch: next song starts immediately at full volume, old one fades out over 58 ms (cos curve), on snap settle; one fading voice max; next/prev preload; pause when hidden (iOS should match: 58 ms fade-out, no fade-in) | live |
| Feed card visuals: row 1 windowed piano roll (playhead 25%, 4 s window = 1 s behind / 3 s ahead, finished notes vanish, active notes brightened 45% + glow, black-key row stripes, loops); row 2 48 log-spaced spectrum bars (40 Hz–16 kHz, instant attack, 150 ms decay) + oscilloscope, both from one MTAudioProcessingTap; TimelineView(.animation)+Canvas, active card only, paused with audio | done (constants from web LiveRoll.tsx; device run unverified) |
| Dark Mode: all colours in asset colour sets with light/dark variants, no hard-coded white/black; previews + light/dark snapshot tests uploaded as the `ios-snapshots` CI artifact | done (dark palette defined on iOS; web has no dark palette yet) |
| Background audio policy: the feed pauses when the app goes to the background (decided) | done |
| Feed ranking: impressions `POST /api/events` (beacon, model_version), personalized For you (candidates + LR nightly + 12% explore + diversity + session steer), admin metrics, privacy line, 60-day retention (docs/social/ranking.md); iOS should send impressions with `x-gbk-install` + `session` | done (web, server) |
| Guest accounts `POST /api/auth/anonymous` (two-word username, idempotent per device via HMAC, 409 HANDLE_TAKEN, 422s, 5 new/20 calls per IP/h), `me.provider`/`is_guest`, guest limits (no publish → 403 GUEST_LIMITED, 20 comments/day, two-word settings), Apple/Google upgrade with guest bearer (`upgraded: linked|merged`) | done (server, prod) |
| Web sign-in only on demand: no standalone Sign in button; gated actions open the sign-in sheet (configured methods) and resume the action after sign-in; Sign out in Profile (feed-design.md) | done (web) |
| Web dark mode: `--so-*` palette on :root with prefers-color-scheme dark set; `--viz-*` derived (LiveRoll); sign-in sheet themed; e2e light/dark | done (web) |
| Play counting `POST /api/shares/:slug/play` | done (live API) |
| Ratings (stars, tap again to clear, double-tap = 5) | done (live API) |
| Comments sheet (flat, post, delete own, report) | done (live API) |
| Report sheet `POST /api/reports` | done (live API) |
| Block `POST /api/blocks/:handle` | wired; route is P4, shows "not available" on 404 |
| Profile: `GET /api/me` + `GET /api/users/:handle` | done (live API; `/api/me` needs a token) |
| Live native endpoints (2df1780): Google sign-in (ASWebAuthenticationSession + PKCE → `POST /api/auth/google/native`), refresh on 401 (rotating, shared across parallel 401s, sign-out on INVALID_REFRESH), logout with refresh_token, StudioWebView one-time code → cookie before /studio, `DELETE /api/me`, push register/unregister in PushManager (unregister before logout, re-register after sign-in) | done; Google needs the iOS client ID; Apple answers 503 → "not available yet"; MockAuthService kept for tests only |
| Sign-in only on demand (feed-design.md, ddf0e38): no standalone Sign in button anywhere. Gated actions (rate, double-tap love, comment Post, report, and the Inbox tab) open the sign-in sheet (prod layout: "Sign in" + close, reason, Continue with Apple / Continue with Google, Reviewer sign-in, "Guests can browse, play and read without an account.", plus the guest name). The pending action is kept in memory and replayed after sign-in. A guest session is enough for rate/comment/report; only Inbox needs Apple/Google. Profile is open to guests (Yisheng, 2026-10-25): own profile with the two-word name, songs and the gear menu (Delete account; Sign out for linked accounts only). Push registers only after a real sign-in | done |
| Guest identity, live: two-word username (adjective + noun, every combo matches `^[A-Z][a-z]{1,11}[A-Z][a-z]{1,11}$`, unit-tested) + Keychain device UUID, `POST /api/auth/anonymous` on launch. 409/422 → new two-word name; 429 → keep local name, retry after `retry-after`; same device adopts the server name. Guests get 20 comments/day (429 message + sign-in sheet that re-posts the draft). Apple/Google send the guest bearer; `upgraded` linked/merged → identity from the returned `me` + `/api/me` reload. No mock for this route. Verified on prod 2026-10-25 with one test deviceId: 200, `me.provider=guest`, `is_guest=true`, repeat call returned the same name | done |
| Feed now-playing viz ported 1:1 from web LiveRoll (gbk #108, db68404, docs/social/feed-design.md): one canvas, roll top 62% / bars+waveform 38%, 4 s window, playhead 25%, past 0.35 / upcoming 0.8 / active lit + outline, fftSize 2048, 48 log bars 40 Hz–16 kHz, instant attack, 150 ms exp decay (dt cap 100 ms), 256-pt waveform, web light/dark viz palette (VizBg/Grid/Row/Head/Bar/Wave/Dim) | done |
| Feed impressions (ranking.md, 8cc9daf): `ImpressionLogger` logs one event per settled card (dwell_ms, listen_ratio, completed ≥0.9 or replay, fast_skip <2 s, replay, actions rate/comment, position, feed, model_version from the feed page) to `POST /api/events` with `client: ios`, `session`, bearer + `x-gbk-install`; flush at 10 events, every 20 s and on background; `/api/feed` gets `?session=` | done |
| Create tab keyboard: studio WKWebView stays above the keyboard and tab bar (SwiftUI keyboard resize, no `.ignoresSafeArea(.keyboard)`), scroll view adds no insets and is pinned when the page fits, so the composer input stays visible. UI test `CreateTabKeyboardUITests` taps the composer input on live /studio with the software keyboard and checks it stays above the keyboard (screenshots in `ios-snapshots`) | done; not checked during playback |
| Background audio mode removed from Info.plist (feed pauses on background) | done |
| sf2player-swift `SF2Engine` dependency | added (pinned 6ce4941), not used yet |
| Reviewer sign-in (App Review): native form → `/signin/reviewer` CSRF + `POST /api/auth/reviewer`, `gbk_cs` stored as Bearer | done (live route; verified to reach the password check from Linux) |
| In-app purchases (GBK Pro, from Stripe tiers; docs/asc/iap.md): StoreKit 2 paywall sheet (Profile "Get Pro" (no native overlay on the Create web view), Studio links to /pricing, compose checkout or Stripe open it instead), monthly/yearly subs in group "GBK Pro" with 7-day trial + lifetime non-consumable, `Transaction.updates` listener, Restore, `appAccountToken` = account UUID (guests can buy), `ios/StoreKit/GBKComposer.storekit`, light/dark paywall snapshot | done; server grant `POST /api/iap/apple` mocked until GBK Social ships it; ASC products not created yet (`docs/asc/scripts/push_iap.py` waits on ASC_ISSUER_ID) |
| Inbox/DMs | placeholder (P4) |
| Signing | `DEVELOPMENT_TEAM` 83D36RPMUM in project.yml; CI builds with `CODE_SIGNING_ALLOWED=NO` |
| App icon | approved by Yisheng (light-blue gradient, #2d6a93 note); keep as is |
| Release | `.github/workflows/ios-release.yml`: manual TestFlight, automatic signing via ASC API key (`-allowProvisioningUpdates`), no p12/profile; build number = run_number; `ITSAppUsesNonExemptEncryption=NO`. Bundle switched to `com.grepawk.moviefone` (2026-10-25, Yisheng's call) to match ASC app 6826906431. Blocked: ASC issuer ID not found on the box, so the key can't authenticate and `APP_STORE_CONNECT_ISSUER_ID` isn't set |
| App Store listing | `docs/asc/`: metadata, privacy label, content rights, age rating, review notes; 5 x 6.9" + 5 x 6.5" screenshots from mockups (2026-10-25); upload script `docs/asc/scripts/push_listing.py` (sets everything except App Privacy and the reviewer password, never submits). Not yet pushed to ASC app 6826906431: waiting for the ASC issuer ID. /privacy, /support, /terms all 200. Bundle com.grepawk.moviefone |
| CI | `ios.yml` (simulator build + tests, light/dark snapshots as `ios-snapshots` artifact) green on b752fff: https://github.com/yishengjiang99/gbk/actions/runs/40225529455 |

### Doc vs prod (checked 2026-10-25 against prod 44b3be2)

- `preview`: prod sends `{ tracks: [color], lo, hi, end, notes: [[trackIndex, start, length, pitch]] }`; the doc says `{ notes: [[pitch, start, dur, track]], duration }`. The iOS model accepts both.
- `GET /api/session` returns `{ authenticated, user, name, provider, csrf, enabled, providers, loginAvailable, reviewerLogin, limits }`, not `{ user, csrf, me }`.
- 404s for unbuilt routes use Fastify's `{ message, error, statusCode }`, not `{ code, message }`.
- `/t/<tag>` is a tag deep link (the M0 app treated it as a thread; fixed).

### Feed visuals vs web (2026-10-25)

Mirrors `src/components/social/LiveRoll.tsx`: PLAYHEAD_X 0.25, WINDOW_SEC 4, BARS 48, BAR_DECAY_MS 150, F_LO 40 / F_HI 16000, bar hue 200→340°, active note `brighten(0.45)` + glow, inactive alpha 0.85, note height 0.85 row, pitch span ≥ 12.
Differences: iOS hides notes once they finish (per the iOS card spec), while web LiveRoll still draws them in the 1 s left of the playhead. iOS also adds the Export video's black-key row stripes. The Export video itself uses an 8 s window with the playhead at 30%; the feed cards use the LiveRoll values. Bars are scaled from dB like the AnalyserNode defaults (-100…-30 dB). The oscilloscope is iOS only for now.
