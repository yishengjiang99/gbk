# gbk Social TODO

## iOS

- Swap `MockAuthService` fallbacks out once iOS-1 routes ship (`/api/auth/apple`, `/api/auth/google/native`, `/api/auth/refresh`, `/api/auth/logout`, `/api/auth/web-code`, `DELETE /api/me`) and P5 push routes ship.
- Google Sign-In SDK integration (needs iOS OAuth client id).
- SF2 playback on `SF2Engine`: copy the sequencer and MIDI parsing from earsheet's `Packages/SF2Player`.
- Web: add a dark palette (prefers-color-scheme) to social.css; iOS dark variants live in Assets.xcassets and can be copied.
- Web: decide whether finished notes should vanish at the playhead (iOS does) and whether to add the oscilloscope.
- Inbox/DMs and blocks list (P4), notifications (P5).
- Align `docs/social-api.md` with prod for `preview`, `/api/session`, and 404 error bodies.

- iOS reviewer path: the app has only Apple/Google sign-in; add a reviewer username/password sign-in (webview to /signin/reviewer or native POST /api/auth/reviewer) before App Review, or review can't reach signed-in features.
- iOS: `/api/auth/apple` and `DELETE /api/me` 404 on prod; both required for review (4.8 sign-in, 5.1.1(v) account deletion).
- iOS screenshots: replace mockups with simulator captures (UI-test snapshot step in ios.yml) once auth routes ship.
- App Store playbook `make_screenshots.py` uses `Image.Lanczos` (breaks on current Pillow); use `Image.LANCZOS`.

### Needs Yisheng

- Give the App Store Connect issuer ID (ASC > Users and Access > Integrations > App Store Connect API, shown above the keys list) so it can be set as `APP_STORE_CONNECT_ISSUER_ID`; key 95M27GJTV7 returned 401 with every issuer UUID found on the box. Then confirm Push, Sign in with Apple and Associated Domains on `com.grepawk.moviefone` and run ios-release.yml.
- App Review notes: reviewer account `openai-reviewer` (password in server config; enter it in App Store Connect review notes) — confirm REVIEWER_LOGIN_ENABLED stays on during review.
- Approve TestFlight submission (`.github/workflows/ios-release.yml` is workflow_dispatch only and has never been run).
- AASA at `/.well-known/apple-app-site-association` (server, iOS-1): app id `83D36RPMUM.com.grepawk.moviefone` (bundle changed to com.grepawk.moviefone).
- Switch the ASC record's bundle ID (app 6826906431, 'GBK Music Composer') from com.grepawk.moviefone to com.grepawk.gbk; the API cannot change an existing record's bundle ID. If ASC won't allow it (a build was uploaded under moviefone), create a new app record for com.grepawk.gbk.
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
