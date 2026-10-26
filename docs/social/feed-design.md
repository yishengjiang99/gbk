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
- **Phone studio = one chat with the composer** (`src/components/studio/MobileStudio.tsx`; viewport under 500px or `window.gbkNative`).
  - Header: song title, a play/pause pill with the time, and `⋯`. Nothing else (no tab bar, rewind, stop, scrubber, lanes or helper text).
  - Input bar (always visible, 16px): `+`, the text box, and the mic (Hum). While composing the mic becomes Stop; with text typed it becomes Send.
  - `+` sheet, exactly three rows: Import sheet music (photo -> in-browser OMR -> the MIDI import chooser; native `scan` handler if the app ever
    advertises one), Import MIDI file (.mid/.midi, same chooser), Connect MIDI keyboard (Web MIDI + on-screen keys; Safari shows
    "MIDI keyboards need Chrome/Edge or the iOS app"; Bluetooth pairing row when `gbkMidiNative.bluetooth`).
  - Every composer reply that changes the song is a version card (v1, v2, ...): Play, Open editor, Publish. Older versions play (audition,
    no state change) and "Restore this version" is one undoable edit (toast with Undo). Edits after the last reply show a "latest edits" card.
  - Composing shows plain-language steps in the chat (repeats collapsed) and a Stop button; errors are one plain sentence, no codes/IDs.
  - `⋯` sheet: Publish & share, Export (MIDI/WAV/video), My songs, Explore, Rename, New song, Settings (model, usage, account).
  - Editor sheet (from a card): small piano roll + full-screen option, then Tracks / Mixer / Sound / Automation (+ Agent when a change waits for approval).
  - Sheets open above the input bar, never over it. Desktop `/studio` is unchanged.
- **No standalone Sign in button anywhere**: not in the header, the feed, the studio, or the composer. Guests browse, play, read comments, open songs in the studio, and type in the composer freely.
- **Gated actions open the sign-in sheet.** These are: rate, comment, follow, DM, report, publish/save, Send in the composer, and the Inbox tab. **Profile is not gated**: a signed-out or guest user can open their own Profile tab. It shows the guest name (web: "Guest"; iOS: the two-word guest name) and offers the sign-in sheet from there. Only Inbox opens the sheet when its tab is tapped.
  - On phones the sheet is a bottom sheet; on desktop it is a centred modal.
  - It lists only the methods the server has configured, in this order: Apple, Google, GitHub, SMS, invite code, reviewer. Web reads these from `/api/session` (`providers`, `apple`, `sms`, `loginAvailable`, `reviewerLogin`).
  - It shows a one-line reason ("Sign in to rate songs.") and "Guests can browse, play and read without an account."
- **Resume the exact action after sign-in.**
  - Web stores the pending action in sessionStorage `gbk.pendingAction` (`compose` text, `rate` slug+stars, `comment` slug+text, `report`, `profile`, `inbox`). It is valid for 15 minutes.
  - Every sign-in path ends in a page load: an OAuth redirect with `?return=`, or an in-place code/SMS login followed by a reload. The owning view then replays the action: it sends the composer text, applies the rating, posts the comment, reopens the report, or opens the tab.
  - iOS keeps the pending action in memory and replays it when the sheet's sign-in completes.
- **Sign out** is in Profile (own profile, below the settings) on web, and in Settings on iOS.
- Code: `src/components/auth/gate.ts` (`needSignIn`, `takePending`), `src/components/auth/SignInSheet.tsx`. Tests: e2e `sign-in only on demand` (WebKit iPhone, Pixel, desktop Chrome).

## Palette (light default, dark via prefers-color-scheme)
- All social colours are `--so-*` custom properties on `:root`, in `src/components/social/social.css`. Light is the default; the dark set applies under `@media (prefers-color-scheme: dark)`. The sign-in sheet uses the same variables.
- Key values (light → dark):
  - accent `#2d6a93 → #61a6d1`
  - surface `#fff → #16283a`
  - text `#16324a → #e6f0f8`
  - roll bg `#f8fcff → #0f1d2a`
  - playhead `#e5396b-ish → #ff5c93`
- The viz canvases (`LiveRoll.tsx`) read the `--viz-*` variables, which are derived from the palette. Theming the piano roll and waveform therefore means editing `--so-*` only.

  | Viz variable | Palette source |
  |---|---|
  | `--viz-bg` | `--so-roll-bg` |
  | `--viz-grid` | `--so-roll-grid` |
  | `--viz-row` | `--so-roll-row` |
  | `--viz-head` | `--so-playhead` |
  | `--viz-bar` | `--so-roll-bar` |
  | `--viz-wave` | `--so-wave` |
  | `--viz-dim` | `--so-muted-border` |

- The studio follows `prefers-color-scheme` too: bright by default (light palette in `workstation.css`, canvas palettes in `PianoRollEditor`/`AutomationLane`), dark only when the device is dark.
- iOS has matching asset colour sets.
