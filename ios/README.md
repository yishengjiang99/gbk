# GBK Composer (iOS) — M0

**License: AGPL-3.0-or-later** for everything under `ios/` (`ios/LICENSE`); the rest of the repo keeps its own terms. Third-party components: `THIRD_PARTY_NOTICES.md`. In the app: Profile › About › Source code.

SwiftUI app for compose.grepawk.com: vertical audio feed, the web studio in a WKWebView, and sign-in-gated Inbox/Profile placeholders. iOS 17+.

## Build

```sh
brew install xcodegen
cd ios
xcodegen            # generates GBKComposer.xcodeproj from project.yml
open GBKComposer.xcodeproj
```

Sheet-music Scan needs the homr models (~102 MB, SHA-pinned): run `scripts/fetch-models` once (writes gitignored `models/`). Without them the app builds and Scan shows "recognition models are not installed". See `docs/ios/scan.md`.

Pick a simulator, then Run (⌘R) or Test (⌘U). Set your development team under Signing & Capabilities to run on a device (Push, Sign in with Apple and Associated Domains need a provisioned App ID).

## Layout

- `GBKComposer/App` — entry point, AppDelegate (APNs callbacks), tabs, theme
- `GBKComposer/Core` — API client (`/api/shares` offset paging behind `FeedProviding`), Keychain auth, push, audio, deep links (`/s`, `/u`, `/t`)
- `GBKComposer/Features` — Feed, Create (studio web view), Inbox, Profile
- `GBKComposerTests` — decoding and request tests

The `sf2player-swift` package is commented out in `project.yml` until its SHA is pinned.
