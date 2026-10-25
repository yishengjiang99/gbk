# gbk Social TODO

## iOS

- GBK Social: App Store IAP verification — `POST /api/iap/apple {signed_transaction, app_account_token}` → `{entitlements, expires_at}`, App Store Server Notifications v2 webhook `POST /api/iap/apple/notifications`, `pro` in `/api/me`; shapes in docs/asc/iap.md. iOS falls back to a local mock while it 404s.

- Sign in with Apple: server answers 503 until `APPLE_BUNDLE_ID` is set; the app shows "not available yet".
- SF2 playback on `SF2Engine`: copy the sequencer and MIDI parsing from earsheet's `Packages/SF2Player`.
- Web: decide whether finished notes should vanish at the playhead (iOS does) and whether to add the oscilloscope.
- Ranking: admin metrics UI view and offline eval script (API `GET /api/admin/metrics` exists) (iOS impressions client done).
- Guest DMs restrictions (no send/receive) land with P4 DMs; guest push for DMs off.
- iOS: follow the sign-in-only-on-demand rule (feed-design.md): remove standalone Sign in, keep pending action in memory and replay.
- IAP pro render limits (120 renders/hour up to 600 s vs 30/h, 300 s) not enforced yet: there is no per-hour render limiter to hook into (daily only).
- Inbox/DMs and blocks list (P4), notifications (P5).
- Scan sheet music (docs/ios/scan.md): consider on-demand model download (~102 MB bundled today); multi-voice/chord accuracy is whatever omr-homr-ios gives; web Scan button only appears inside the app.
- Align `docs/social-api.md` with prod for `preview`, `/api/session`, and 404 error bodies.

- iOS reviewer path: the app has only Apple/Google sign-in; add a reviewer username/password sign-in (webview to /signin/reviewer or native POST /api/auth/reviewer) before App Review, or review can't reach signed-in features.
- iOS: `/api/auth/apple` and `DELETE /api/me` 404 on prod; both required for review (4.8 sign-in, 5.1.1(v) account deletion).
- iOS screenshots: replace mockups with simulator captures (UI-test snapshot step in ios.yml) once auth routes ship.
- App Store playbook `make_screenshots.py` uses `Image.Lanczos` (breaks on current Pillow); use `Image.LANCZOS`.

### Needs Yisheng
- AGPL decision for omr-homr-ios: **decided 2026-10-25**, `ios/` is AGPL-3.0-or-later and links omr-homr-ios. Remaining: confirm the App Store listing's open-source paragraph (docs/asc/metadata/en-US/description.txt) and that distributing an AGPL binary via the App Store is acceptable to you (the App Store's usage rules are the known GPL-family friction; we own the gbk iOS copyright, homr upstream is liebharc's).
- App Store Connect → App Information → App Store Server Notifications v2: set Production and Sandbox URL to `https://compose.grepawk.com/api/iap/apple/notifications` (endpoint is live).
- Decide whether prod accepts sandbox IAP receipts (App Review/TestFlight need it): `IAP_ALLOW_SANDBOX=1` in the prod env.

- IAP: accept the **Paid Apps agreement** and fill **banking + tax** in ASC > Business (IAPs can't be sold/sandbox-purchased without it); then `ASC_ISSUER_ID=… python3 docs/asc/scripts/push_iap.py` (creates group "GBK Pro", pro_monthly $5.99, pro_yearly $47.99, lifetime $99.99) and `--verify`. Confirm lifetime at $99.99 (no $99.00 App Store price point) and that lifetime is still wanted. Set the App Store Server Notifications v2 URL once GBK Social ships the webhook. Attach the IAPs to the next version when submitting (manual; nothing is submitted by scripts). Add paid-plan terms/EULA link before selling.
- Web Studio inside the app must not show Stripe buy buttons (guideline 3.1.1): the iOS WebView intercepts /pricing, compose checkout and stripe.com and opens the paywall instead; keep any new buy links on those paths.
- Create an iOS OAuth client in Google Cloud Console (same project as the web `GOOGLE_CLIENT_ID`, bundle ID com.grepawk.moviefone). Put its ID in `ios/project.yml` `GOOGLE_IOS_CLIENT_ID` (and the reversed form in `GOOGLE_REVERSED_CLIENT_ID`), and add it to the server env `GOOGLE_IOS_CLIENT_IDS`. None exists in the repo or server config today.
- Set `APPLE_BUNDLE_ID` on the server to enable Sign in with Apple (`/api/auth/apple` returns 503 until then), and `IOS_APP_IDS` for the AASA file (404 today).

- Give the App Store Connect issuer ID (ASC > Users and Access > Integrations > App Store Connect API, shown above the keys list) so it can be set as `APP_STORE_CONNECT_ISSUER_ID`; key 95M27GJTV7 returned 401 with every issuer UUID found on the box. Then confirm Push, Sign in with Apple and Associated Domains on `com.grepawk.moviefone` and run ios-release.yml.
- App Review notes: reviewer account `openai-reviewer` (password in server config; enter it in App Store Connect review notes) — confirm REVIEWER_LOGIN_ENABLED stays on during review.
- Approve TestFlight submission (`.github/workflows/ios-release.yml` is workflow_dispatch only and has never been run).
- AASA at `/.well-known/apple-app-site-association` (server, iOS-1): app id `83D36RPMUM.com.grepawk.moviefone` (iOS bundle is now com.grepawk.moviefone).
- Enter the review password for `openai-reviewer` in ASC App Review Information, and fill App Privacy / age rating from `docs/asc/app-review.md`.
- Approve the listing copy and screenshots in `docs/asc/` (screenshots are mockups, not simulator captures).
- Server push (P5) reuses the existing team-wide APNs key; configure it on the server only, never copy key material.

## Commercialization

Open items (owner in brackets):

- [ ] Pro limits enforcement in the MCP server (~60 lines) [GBK Launch]
- [ ] Paid-plan terms + refund policy [Music Biz]
- [ ] Private support channel for paying customers [Music Biz]
- [ ] ChatGPT listing (pending review) [GBK Launch]
- [ ] Stripe customer portal (manage/cancel subscription) [Music Biz]
- [ ] Apple guideline 3.1.3 check for the music app (web checkout vs IAP) [Music Biz]
- [ ] X Ads API application [Yisheng]
- [ ] Waitlist launch email [Music Biz, needs approval]
- [ ] Rename to EarSheet in the demo + fix dead Page tab [EarSheet]

### Needs Yisheng

- [ ] Set Stripe price env vars (MUSIC_* / COMPOSE_*) and restart the server after finalcut#118/#120
- [ ] Approve earsheet#95 (publishes public landing site)
- [ ] Confirm price: $6/mo or $48/yr (lifetime $99 flagged risky)
- [ ] Submit X Ads API application
- [ ] Approve the launch email

- [ ] GBK Launch: wire Pro limits. `/etc/gbk-composer.env` now has `COMPOSE_ENTITLEMENT_TOKEN` (same value as grepawk.com's); gbk has no consumer yet. Call `GET https://grepawk.com/api/compose/entitlement?email=…` with `Authorization: Bearer $COMPOSE_ENTITLEMENT_TOKEN` and raise limits when `pro: true`. See docs/stripe.md.
- ASC listing: run `ASC_ISSUER_ID=... python3 docs/asc/scripts/push_listing.py` then `--verify`; enter App Privacy answers (docs/asc/app-review.md) and the `openai-reviewer` password and review contact by hand; check the icon once the TestFlight build processes.
