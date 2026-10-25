# gbk Social TODO

## iOS

- Web (GBK Social): in the Keys/MIDI UI, when `window.gbkMidiNative?.bluetooth`, show a "Bluetooth MIDI" button calling `window.gbkMidiNative.openBluetoothPairing()` (iOS app pairing sheet; today only in Profile ⚙︎). Contract: docs/ios/midi.md.
- iOS MIDI: test with a real USB keyboard, a BLE MIDI device and a network session on device; measure end-to-end (key → sound) latency on device.
- iOS: manually verify the studio import picker lists .mid/.midi from Files and the import lands (CI can't drive the Files sheet).

- Sign in with Apple: server answers 503 until `APPLE_BUNDLE_ID` is set; the app shows "not available yet".
- SF2 playback on `SF2Engine`: copy the sequencer and MIDI parsing from earsheet's `Packages/SF2Player`.
- Web: decide whether finished notes should vanish at the playhead (iOS does) and whether to add the oscilloscope.
- Ranking: admin metrics UI view (API `GET /api/admin/metrics` exists) (iOS impressions client done).
- Ranking: wire `follow` impression action when follow ships (`markFollow` web, `FeedAction.follow` iOS are ready).
- Guest DMs restrictions (no send/receive) land with P4 DMs; guest push for DMs off.
- iOS: follow the sign-in-only-on-demand rule (feed-design.md): remove standalone Sign in, keep pending action in memory and replay.
- IAP pro render limits (120 renders/hour up to 600 s vs 30/h, 300 s) not enforced yet: there is no per-hour render limiter to hook into (daily only).
- Inbox/DMs and blocks list (P4), notifications (P5).
- GBK Social: land the web half of Scan (docs/ios/scan.md "Web contract": Scan button next to Hum when `gbkNative.capabilities` has "scan", `webkit.messageHandlers.gbkScan.postMessage({type:"scan.start", project})`, `window.gbkStudio.applyNativeOps(ops)`); patch from iOS worker.
- Scan sheet music (docs/ios/scan.md): consider on-demand model download (~102 MB bundled today); multi-voice/chord accuracy is whatever omr-homr-ios gives; web Scan button only appears inside the app.
- Align `docs/social-api.md` with prod for `preview`, `/api/session`, and 404 error bodies.

- iOS reviewer path: the app has only Apple/Google sign-in; add a reviewer username/password sign-in (webview to /signin/reviewer or native POST /api/auth/reviewer) before App Review, or review can't reach signed-in features.
- iOS: `/api/auth/apple` and `DELETE /api/me` 404 on prod; both required for review (4.8 sign-in, 5.1.1(v) account deletion).
- iOS screenshots: replace mockups with simulator captures (UI-test snapshot step in ios.yml) once auth routes ship.
- App Store playbook `make_screenshots.py` uses `Image.Lanczos` (breaks on current Pillow); use `Image.LANCZOS`.

### Needs Yisheng
- [ ] #108 real-iPhone check, native app (TestFlight build): open Feed, play a song, scroll to the next card. Only the playing card's piano roll moves; the old song fades out fast (~58 ms, no click), the new one starts at full volume right away.
- [ ] #108 real-iPhone check, Safari: open https://compose.grepawk.com/feed, tap play once, then swipe up. The next song should play without another tap, the page shouldn't scroll sideways, and the playing card should animate smoothly (Settings > Developer > Show FPS, or just look for stutter). Check both light and dark mode.
- [ ] Native Hum on device: Create > open a song > Hum, allow the mic, hum ~5 s, Stop. A track appears (needs GBK Social's `window.gbkHum` bridge).
- AGPL decision for omr-homr-ios: **decided 2026-10-25**, `ios/` is AGPL-3.0-or-later and links omr-homr-ios. Remaining: confirm the App Store listing's open-source paragraph (docs/asc/metadata/en-US/description.txt) and that distributing an AGPL binary via the App Store is acceptable to you (the App Store's usage rules are the known GPL-family friction; we own the gbk iOS copyright, homr upstream is liebharc's).
- App Store Connect → App Information → App Store Server Notifications v2: set Production and Sandbox URL to `https://compose.grepawk.com/api/iap/apple/notifications` (endpoint is live).
- Decide whether prod accepts sandbox IAP receipts (App Review/TestFlight need it): `IAP_ALLOW_SANDBOX=1` in the prod env.

- IAP: accept the **Paid Apps agreement** and fill **banking + tax** in ASC > Business (IAPs can't be sold/sandbox-purchased without it); then `ASC_ISSUER_ID=… python3 docs/asc/scripts/push_iap.py` (creates group "GBK Pro", pro_monthly $5.99, pro_yearly $47.99, lifetime $99.99) and `--verify`. Confirm lifetime at $99.99 (no $99.00 App Store price point) and that lifetime is still wanted. Set the App Store Server Notifications v2 URL once GBK Social ships the webhook. Attach the IAPs to the next version when submitting (manual; nothing is submitted by scripts). Add paid-plan terms/EULA link before selling.
- Web Studio inside the app must not show Stripe buy buttons (guideline 3.1.1): the iOS WebView intercepts /pricing, compose checkout and stripe.com and opens the paywall instead; keep any new buy links on those paths.
- Create an iOS OAuth client in Google Cloud Console (same project as the web `GOOGLE_CLIENT_ID`, bundle ID com.grepawk.moviefone). Put its ID in `ios/project.yml` `GOOGLE_IOS_CLIENT_ID` (and the reversed form in `GOOGLE_REVERSED_CLIENT_ID`), and add it to the server env `GOOGLE_IOS_CLIENT_IDS`. None exists in the repo or server config today.
- Set `APPLE_BUNDLE_ID` on the server to enable Sign in with Apple (`/api/auth/apple` returns 503 until then), and `IOS_APP_IDS` for the AASA file (404 today).

- Confirm Push, Sign in with Apple and Associated Domains capabilities on `com.grepawk.moviefone` (CI build 4 signed fine with automatic signing).
- App Review notes: reviewer account `openai-reviewer` (password in server config; enter it in App Store Connect review notes) — confirm REVIEWER_LOGIN_ENABLED stays on during review.
- TestFlight 0.1.0 (4) is live for internal testers (group "Internal", you are invited at yisheng.jiang@gmail.com; add other ASC users there). Approve before any external TestFlight (Beta App Review) or App Store submission.
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
- ASC listing pushed 2026-10-25 (metadata + 10 screenshots); IAPs created (3, READY_TO_SUBMIT). Still by hand: enter App Privacy answers (docs/asc/app-review.md) and the `openai-reviewer` password and review contact by hand; check the icon once the TestFlight build processes.
