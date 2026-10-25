# GBK Composer (iOS) — M0

SwiftUI app for compose.grepawk.com: vertical audio feed, the web studio in a WKWebView, and sign-in-gated Inbox/Profile placeholders. iOS 17+.

## Build

```sh
brew install xcodegen
cd ios
xcodegen            # generates GBKComposer.xcodeproj from project.yml
open GBKComposer.xcodeproj
```

Pick a simulator, then Run (⌘R) or Test (⌘U). Set your development team under Signing & Capabilities to run on a device (Push, Sign in with Apple and Associated Domains need a provisioned App ID).

## Layout

- `GBKComposer/App` — entry point, AppDelegate (APNs callbacks), tabs, theme
- `GBKComposer/Core` — API client (`/api/shares` offset paging behind `FeedProviding`), Keychain auth, push, audio, deep links (`/s`, `/u`, `/t`)
- `GBKComposer/Features` — Feed, Create (studio web view), Inbox, Profile
- `GBKComposerTests` — decoding and request tests

The `sf2player-swift` package is commented out in `project.yml` until its SHA is pinned.
