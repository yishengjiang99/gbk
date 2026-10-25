# gbk Social TODO

## iOS

- Swap `MockAuthService` fallbacks out once iOS-1 routes ship (`/api/auth/apple`, `/api/auth/google/native`, `/api/auth/refresh`, `/api/auth/logout`, `/api/auth/web-code`, `DELETE /api/me`) and P5 push routes ship.
- Google Sign-In SDK integration (needs iOS OAuth client id).
- SF2 playback on `SF2Engine`: copy the sequencer and MIDI parsing from earsheet's `Packages/SF2Player`.
- Piano-roll preview rendering on feed cards (prod `preview` shape).
- Inbox/DMs and blocks list (P4), notifications (P5).
- Align `docs/social-api.md` with prod for `preview`, `/api/session`, and 404 error bodies.

### Needs Yisheng

- Apple Developer team ID and App ID `com.grepawk.gbkcomposer` with Push, Sign in with Apple and Associated Domains enabled.
- Signing (development team in Xcode / CI signing secrets for archive builds).
- AASA file at `https://compose.grepawk.com/.well-known/apple-app-site-association` needs the team ID (`<TEAMID>.com.grepawk.gbkcomposer`).
- App icon (1024×1024) for `ios/GBKComposer/Resources/Assets.xcassets/AppIcon.appiconset`.
- TestFlight / App Store Connect app record and approval.
- APNs .p8 key for the server sender (P5).
