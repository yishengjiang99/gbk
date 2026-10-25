# Feed & Studio design spec (web is design lead; GBK iOS follows)

Constants also live in `docs/social-api.md` → "Client behavior".

## Standing rules
- **The Composer text input is always visible** in Studio/Create, on mobile and desktop, whichever tab is selected (Tracks, Composer, Agent, Sound, Files). This holds after the keyboard opens or closes and during playback. Never hide or collapse it.
  - Web: one ComposerPanel instance. On the Composer tab it is the full panel. On every other tab only its input row (plus run status, or the sign-in button when signed out) is docked at the bottom of the side column, above the bottom bars, padded by `env(safe-area-inset-bottom)`.
  - The side column never shrinks below the tab strip plus the dock (`min-height: 96px + safe area`).
  - Inputs are 16px on mobile (no iOS zoom). No horizontal overflow. Desktop `/studio` has no vertical page scroll.
  - Enforced by the e2e test "composer input always visible" (WebKit iPhone, Pixel, desktop Chrome): for every tab it checks the input is visible and inside the viewport when focused, with a short (keyboard-open) viewport, after blur, and during playback.
- `/` paints the Feed shell first and never the studio (see the "first paint" e2e test).

## Feed audio
- The next song starts immediately at full volume. The previous song fades out over **58 ms** (`FADE_OUT_MS = 58`, gain `cos(t·π/2)`).
- The switch happens on scroll settle. At most one voice fades at a time. The next and previous songs are preloaded. Playback pauses when the tab or app is hidden.

## Design rule: sign-in only when an action needs it (web + iOS)
- **No standalone Sign in button anywhere**: not in the header, the feed, the studio, or the composer. Guests browse, play, read comments, open songs in the studio, and type in the composer freely.
- **Gated actions open the sign-in sheet.** These are: rate, comment, follow, DM, report, publish/save, Send in the composer, and the Profile and Inbox tabs.
  - On phones the sheet is a bottom sheet; on desktop it is a centred modal.
  - It lists only the methods the server has configured, in this order: Apple, Google, GitHub, SMS, invite code, reviewer. Web reads these from `/api/session` (`providers`, `apple`, `sms`, `loginAvailable`, `reviewerLogin`).
  - It shows a one-line reason ("Sign in to rate songs.") and "Guests can browse, play and read without an account."
- **Resume the exact action after sign-in.**
  - Web stores the pending action in sessionStorage `gbk.pendingAction` (`compose` text, `rate` slug+stars, `comment` slug+text, `report`, `profile`, `inbox`). It is valid for 15 minutes.
  - Every sign-in path ends in a page load: an OAuth redirect with `?return=`, or an in-place code/SMS login followed by a reload. The owning view then replays the action: it sends the composer text, applies the rating, posts the comment, reopens the report, or opens the tab.
  - iOS keeps the pending action in memory and replays it when the sheet's sign-in completes.
- **Sign out** is in Profile (own profile, below the settings) on web, and in Settings on iOS.
- Code: `src/components/auth/gate.ts` (`needSignIn`, `takePending`), `src/components/auth/SignInSheet.tsx`. Tests: e2e `sign-in only on demand` (WebKit iPhone, Pixel, desktop Chrome).
