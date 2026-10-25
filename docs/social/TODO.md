# gbk Social TODO

## iOS

- Swap `MockAuthService` fallbacks out once iOS-1 routes ship (`/api/auth/apple`, `/api/auth/google/native`, `/api/auth/refresh`, `/api/auth/logout`, `/api/auth/web-code`, `DELETE /api/me`) and P5 push routes ship.
- Google Sign-In SDK integration (needs iOS OAuth client id).
- SF2 playback on `SF2Engine`: copy the sequencer and MIDI parsing from earsheet's `Packages/SF2Player`.
- Piano-roll preview rendering on feed cards (prod `preview` shape).
- Inbox/DMs and blocks list (P4), notifications (P5).
- Align `docs/social-api.md` with prod for `preview`, `/api/session`, and 404 error bodies.

### Needs Yisheng

- Team ID is almost certainly `83D36RPMUM` (the team every other iOS app here uses); confirm reusing it, plus the existing team-wide APNs .p8 key and the App Store Connect API key from finalcut (gbk repo has no ASC secrets yet).
- Apple Developer App ID `com.grepawk.gbkcomposer` with Push, Sign in with Apple and Associated Domains enabled.
- Signing (development team in Xcode / CI signing secrets for archive builds).
- AASA file at `https://compose.grepawk.com/.well-known/apple-app-site-association` needs the team ID (`<TEAMID>.com.grepawk.gbkcomposer`).
- App icon (1024×1024) for `ios/GBKComposer/Resources/Assets.xcassets/AppIcon.appiconset`.
- TestFlight / App Store Connect app record and approval.
- APNs .p8 key for the server sender (P5).

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
