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
