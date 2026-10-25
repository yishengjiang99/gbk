# gbk Social API (v1 contract)

Base URL: `https://compose.grepawk.com`. JSON in and out (`content-type: application/json`), UTF-8.
This is the contract the web app and the native iOS client both build against. Each endpoint is tagged with the
phase that ships it: **P1** schema, profiles/handles, publish, ratings, comments, Feed API/UI, reports;
**P2** feed ranking polish/filters UI; **P3** prompt sharing + Remix; **P4** DMs/inbox/blocks; **P5** notifications + APNs;
**iOS-1** native auth exchange. Endpoints not yet live return `404`.

## Conventions

- **Auth.** Either the web session cookie (`gbk_cs`, set by Google/GitHub OAuth at `/api/auth/:provider`) or
  `Authorization: Bearer <token>`. Bearer tokens are session tokens returned by the token-exchange endpoints below.
  - Cookie writes need same-origin `Origin` + `x-gbk-csrf` header (value from `GET /api/session`).
  - Bearer writes need neither (no ambient credentials). Never send both.
- **Errors.** App errors are `{ "code": "UPPER_SNAKE", "message": "human text" }` with HTTP 400/401/403/404/409/413/422/429.
  Unknown `/api/*` routes (including routes of phases not yet shipped) return 404 `{ "code": "NOT_FOUND", "message": "Route GET:/api/x not found", "error": "Not Found", "statusCode": 404 }`.
  Framework errors (bad JSON, body too large, schema validation) keep Fastify's shape `{ "statusCode", "error", "message", "code"? }` where `code` may be an `FST_ERR_*` string or absent.
  Clients should read `message` always, `code` when present, and fall back to the HTTP status.
  `401 UNAUTHENTICATED`, `403 FORBIDDEN|BLOCKED|DMS_OFF`, `404 NOT_FOUND`, `422 INVALID_*`, `429 RATE_LIMITED` (+ `retry-after` seconds).
- **Pagination.** Cursor based: response has `next_cursor` (opaque string, `null` at end). Pass `?cursor=<next_cursor>`; `limit` 1–50, default 20.
- **Time.** Epoch milliseconds (`created_at`, …), UTC.
- **IDs.** Songs are addressed by `slug`; users by `handle` (lowercase `a-z0-9_`, 3–20). Comments/messages by numeric-string `id`.
- **Cursor format.** `next_cursor` is an opaque base64url string; never parse or build it. Same filters must be resent with it.
- **Backward compatibility.** `GET /api/shares` (offset pagination, camelCase `ShareView`) stays unchanged; new social fields live only on the new endpoints.
- **Deep links.** `https://compose.grepawk.com/s/<slug>` (song), `/u/<handle>` (profile), `/t/<tag>` (tag), `/inbox/<handle>` (DM thread).
  `GET /.well-known/apple-app-site-association` (live; app id `83D36RPMUM.com.grepawk.moviefone` by default, override with `IOS_APP_IDS`, set it empty to disable) lists paths `/s/*`, `/u/*`, `/t/*` for the app id.
- **Text.** All user text is plain text; clients must render it as text (no HTML/markdown).

### Objects

```jsonc
// User (public)
{ "handle": "yisheng", "display_name": "Yisheng", "avatar_url": null, "song_count": 12, "rating_avg": 4.3, "created_at": 0 }

// Song (feed item / detail)
{
  "slug": "minuet-in-g-a1b2c3", "title": "Minuet in G", "url": "https://compose.grepawk.com/s/minuet-in-g-a1b2c3",
  "author": User, "created_at": 0, "published_at": 0,
  "labels": ["classical"], "tags": ["fugue", "piano"],
  "rating_avg": 4.5, "rating_count": 8, "comment_count": 3, "play_count": 120, "fork_count": 1,
  "my_rating": 5,                       // null if not rated / guest (only visible to the rater)
  "media": { "mp3": "https://…/api/shares/<slug>/media/mp3", "wav": "https://…/media/wav", "midi": "https://…/media/midi" }, // null when absent
  "preview": { "tracks": ["#4fc3f7", "#e57373"], "lo": 48, "hi": 84, "end": 7680, "notes": [[track, start, len, pitch]] }, // may be null
  // preview: tracks = color per track index; lo/hi = pitch range; end = song length in ticks; notes = [trackIndex, start 0..1000, length 0..1000, MIDI pitch]
  // (start/length are normalized to the song length, up to 240 notes sampled evenly). Map to seconds with the audio duration: s = start / 1000 * duration.
  "prompt_shared": false, "prompt_text": null,   // P3; text only when owner opted in
  "parent_slug": null, "is_mine": false
}

// Comment
{ "id": "17", "author": User, "body": "nice", "created_at": 0, "can_delete": false }
```

Labels (fixed set, max 3): `ambient lofi classical jazz electronic cinematic game pop experimental wip`.
Tags: max 10, lowercase `a-z0-9-`, 2–24 chars.

## Auth & session (iOS-1 unless noted)

Every `/api/*` route accepts `Authorization: Bearer <access_token>` (live since P1: bearer = the web session token value; write routes skip Origin/CSRF for bearer).
Tokens are minted by the existing `/oauth` token machinery (same signing, same `user` id as web accounts).

| Method + path | Phase | Notes |
|---|---|---|
| `GET /api/session` | live | `{ authenticated, user, name, provider, csrf, enabled, providers, loginAvailable, reviewerLogin, limits }`. `user` is the account id or null, `provider` e.g. `"google"`. Fetch `GET /api/me` for the social profile |
| `POST /api/auth/apple` | live; client id = bundle `com.grepawk.moviefone` by default (`APPLE_BUNDLE_ID` overrides; empty disables → 503 `APPLE_UNAVAILABLE`) | `{ identityToken, nonce, displayName? }`. Verifies Apple JWT (JWKS, `aud` = bundle id, `sha256(nonce)` = claim). → `TokenPair` |
| `POST /api/auth/google/native` | live | `{ idToken }` (`aud` = iOS client id). → `TokenPair` |
| `GET /api/auth/apple/web?return=` | live (503 until `APPLE_SERVICES_ID`) | web Sign in with Apple (form_post to `POST /api/auth/apple/callback`, id_token verified, nonce bound to a state cookie) |
| `GET /api/auth/sms/config` | live | `{ enabled, turnstileSiteKey, countries }` |
| `POST /api/auth/sms/start` | live (503 until Twilio + Turnstile keys) | `{ phone, turnstileToken }` → `{ ok: true }` (generic). Turnstile is checked before any SMS; country allowlist `SMS_COUNTRY_PREFIXES` (default `+1`); limits 5/h per IP, 3/15 min + 10/day per phone, 200/h global |
| `POST /api/auth/sms/verify` | live (503 until configured) | `{ phone, code, client?: "native" }` → web: cookie session `{ ok, csrf }`; native: `TokenPair`. 5 checks / 15 min per phone |
| `POST /api/auth/refresh` | live | `{ refresh_token }` → `TokenPair` (rotating, single use; the old access token is revoked too; re-using a spent refresh token revokes all of the user's refresh tokens → `401 INVALID_REFRESH`, sign in again) |
| `POST /api/auth/logout` | live | revokes the presented access + refresh tokens |
| `POST /api/auth/web-code` | live | bearer → `{ code, expires_in: 60 }` one-time code |
| `GET /api/auth/web-code/redeem?code=&return=/studio` | live | sets the cookie session in the WKWebView, 302 to `return` (same-origin path only). Single use, 60 s |
| `DELETE /api/me` | live | deletes account, songs, comments, ratings, messages, devices; → `{ ok: true }` (App Store 5.1.1(v)) |

`TokenPair` = `{ access_token, token_type: "Bearer", expires_in: 3600, refresh_token, me: Me }`.

### Guest accounts (iOS, spec; implementation follows)

Reads need no auth: `GET /api/feed`, `/api/tags/top`, `/api/tags/:tag`, `/api/songs/:slug`, `/api/users/:handle`, `/api/shares/:slug/comments`, plus the `/s/<slug>`, `/u/<handle>` and `/t/<tag>` pages.
Reads with a guest or full bearer add viewer fields (`my_rating`, `is_mine`, `can_delete`).

`POST /api/auth/anonymous` (no auth): `{ deviceId, username }` → `{ token, refreshToken, user, ...TokenPair }`.
- `token` = `access_token`, `refreshToken` = `refresh_token`, `user` = `me`. Both naming styles are present. Refresh and logout work as for other tokens.
- `deviceId`: 16–128 chars of `[A-Za-z0-9-_]`, e.g. `identifierForVendor` or a Keychain UUID. The server stores only an HMAC of it.
- `username`: exactly two capitalized English words, letters only, no digits or spaces, 4–20 chars. Regex `^[A-Z][a-z]{1,11}[A-Z][a-z]{1,11}$`, e.g. `MellowFox`. Blocklisted words → `422`.
  - `display_name` = `MellowFox`, `handle` = `mellowfox` (lowercase). `me.provider` = `"guest"`, `me.is_guest` = `true`.
- **Idempotent per device:** a known `deviceId` returns its existing guest with fresh tokens. The `username` is then ignored, never 409.
- **Collision:** a new device whose handle is taken (by anyone) → `409 { code: "HANDLE_TAKEN", message, error: "Conflict", statusCode: 409 }`. The server never appends digits; the client generates a new two-word combo and retries.
- **Errors:** invalid input → `422 { code: "INVALID_USERNAME" | "INVALID_DEVICE", message, error, statusCode }`.
- **Rate limit:** 5 new guests per IP per hour and 20 calls per IP per hour; idempotent repeats count toward the 20. Over the limit → `429` with `retry-after`.
- **Guest permissions:**
  - Allowed: play, rate, comment (comments 20/day), report, block.
  - Allowed: edit display name or handle via `PATCH /api/me/settings`, under the same two-word rule while still a guest. Set `dm_policy`. `DELETE /api/me`.
  - Not allowed: publishing public songs (`POST /api/shares` with `public: true` → `403 GUEST_LIMITED`), sending DMs (`403 GUEST_LIMITED`), receiving DMs from others (guests behave as `dm_policy: "off"`), and push for DMs. Comment and rating push works after `POST /api/push/register`.
  - Sign in with Apple or Google to lift the limits.

**Upgrade on sign-in.** `POST /api/auth/apple` and `POST /api/auth/google/native` accept an optional `Authorization: Bearer <guest access token>`.
- If the bearer is a valid guest and the Apple/Google identity has **no** account yet, the guest account is upgraded in place. Same user id, handle, display name, ratings, comments, blocks and devices; the Apple/Google identity is attached and `is_guest` becomes `false`. All the guest's refresh tokens are revoked and a new `TokenPair` is returned with `upgraded: "linked"`.
- If the identity **already** has an account, that account wins and is returned (`upgraded: "merged"`).
  - The guest's ratings move over unless that account already rated the same song.
  - The guest's comments, reports, blocks and push devices are re-owned by that account.
  - The guest account and its handle are then deleted.
- If the bearer is missing, invalid or not a guest, sign-in behaves as before (`upgraded` absent). An invalid bearer is ignored, never an error.

`Me` gains `provider` (`"google"|"apple"|"phone"|"github"|"guest"`) and `is_guest`.
`Me` = `User` + `{ "id": "...", "dm_policy": "all|off", "handle_changed": false, "is_admin": false }`.

## Me / profiles (P1)

| Method + path | Who | Notes |
|---|---|---|
| `GET /api/me` | signed-in | `Me` (auto-creates profile; handle derived from display name with numeric suffix for uniqueness) |
| `PATCH /api/me/settings` | signed-in | `{ display_name?, handle?, dm_policy? }`. Handle changeable once → `409 HANDLE_TAKEN`, `403 HANDLE_LOCKED` |
| `GET /api/users/:handle` | anyone | `{ user: User, songs: Song[], next_cursor }` (published songs, newest first, `?cursor`) |

## Feed & songs (P1)

| Method + path | Who | Notes |
|---|---|---|
| `GET /api/feed?sort=for_you|new|top&label=&tag=&cursor=&limit=` | anyone | `{ items: Song[], next_cursor }`. Default `for_you` (ranked score, `wip` excluded unless `label=wip`). |
| `GET /api/songs/:slug` | anyone (public) / owner | Song (exact feed item shape) |
| `GET /api/shares/:slug` | anyone (public) / owner | legacy detail incl. `project` JSON for the studio (unchanged) |
| `PATCH /api/shares/:slug` | owner | `{ title?, public? }` (unchanged; `public: true` = publish) |
| `PATCH /api/songs/:slug/meta` | owner | `{ labels?, tags?, prompt_shared?, prompt_text? }` → Song |
| `POST /api/shares/:slug/play` | anyone | count a play (deduped per user/IP per hour) → `{ play_count }` |
| `GET /api/tags/top?limit=` | anyone | `{ tags: [{ tag, count }] }`, plus `labels: [{label,count}]` |
| `GET /api/tags/:tag?cursor=` | anyone | same shape as feed |

## Ratings & comments (P1)

| Method + path | Who | Notes |
|---|---|---|
| `PUT /api/shares/:slug/rating` | signed-in, not owner | `{ stars: 1..5 }` → `{ rating_avg, rating_count, my_rating }`. 60/min |
| `DELETE /api/shares/:slug/rating` | signed-in | clears; same response |
| `GET /api/shares/:slug/comments?order=new|old&cursor=` | anyone | `{ items: Comment[], next_cursor }` (hides comments by users you blocked) |
| `POST /api/shares/:slug/comments` | signed-in | `{ body }` ≤500 chars → Comment. 10/min, 100/day. Word filter → `422 INVALID_TEXT` |
| `DELETE /api/comments/:id` | author or song owner | soft delete → `{ ok: true }` |

"Like" on iOS maps to rating (e.g. double-tap = 5 stars); there is no separate like endpoint.

## Reports & moderation (P1)

| Method + path | Who | Notes |
|---|---|---|
| `POST /api/reports` | signed-in | `{ kind: "comment|message|song|user", target: id|slug|handle, reason ≤500 }` → `{ ok, id }`. 10/hour. 3 distinct reports auto-hide a comment |
| `GET /api/admin/reports?status=open|resolved&cursor=` | admin | `{ items: [{ id, kind, target, reason, reporter, status, created_at, preview }], next_cursor }` |
| `POST /api/admin/reports/:id` | admin | `{ action: "hide|dismiss" }` |

## Blocks, inbox & DMs (P4)

Blocks ship with P4. Until P4 is deployed these routes return the 404 `NOT_FOUND` shape above.

| Method + path | Who | Notes |
|---|---|---|
| `POST /api/blocks/:handle` / `DELETE` | signed-in | block is mutual for DMs, hides their comments for you |
| `GET /api/blocks` | signed-in | `{ items: User[] }` |
| `GET /api/inbox?cursor=` | signed-in | `{ items: [{ with: User, last: Message, unread: 2, updated_at }], next_cursor }` |
| `GET /api/inbox/unread` | signed-in | `{ count }` (poll ≤ every 20 s) |
| `GET /api/dm/:handle?before=&limit=` | signed-in | `{ with: User, items: Message[] (oldest→newest), next_cursor }`; marks read |
| `POST /api/dm/:handle` | signed-in | `{ body ≤1000, share_slug? }` → Message. `403 BLOCKED|DMS_OFF`. 20/min; new accounts ≤5 new conversations/day |

`Message` = `{ id, from: handle, body, share: Song|null, created_at }`.

## Notifications & push (P5)

| Method + path | Who | Notes |
|---|---|---|
| `GET /api/notifications?cursor=` | signed-in | `{ items: [{ id, kind: "comment|rating|fork|dm", actor: User, song_slug?, created_at, read }], unread }` |
| `POST /api/notifications/read` | signed-in | `{ ids? }` (all if omitted) |
| `POST /api/push/register` | signed-in (live) | `{ installId, token: "<APNs hex>", environment: "production|sandbox" }` → `{ ok }` (upsert by installId; modeled on earsheet devices.ts) |
| `POST /api/push/unregister` | signed-in (live) | `{ installId }` → `{ ok }` (call on logout) |

APNs sender (token-based .p8 auth, ported from earsheet apns.ts) fires on: comment on your song, public fork of your song (live), new DM (P4).
Payload: `{ aps: { alert: { title, body }, sound }, kind: "comment|fork|dm", link }`. Dead tokens (410/BadDeviceToken) are dropped.

Server env (all optional; never commit values): `APPLE_SERVICES_ID`, `TWILIO_ACCOUNT_SID`, `TWILIO_VERIFY_SID`, `TWILIO_AUTH_TOKEN` (or `TWILIO_API_KEY` + `TWILIO_API_SECRET`), `TURNSTILE_SECRET`, `TURNSTILE_SITE_KEY`, `SMS_COUNTRY_PREFIXES`, `APPLE_BUNDLE_ID`, `GOOGLE_IOS_CLIENT_IDS` (comma list; the web `GOOGLE_CLIENT_ID` is also accepted as audience),
`IOS_APP_IDS` (e.g. `83D36RPMUM.com.grepawk.moviefone` (default), enables AASA), `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_P8` or `APNS_P8_PATH`, `APNS_TOPIC` (defaults to the bundle id `com.grepawk.moviefone`).
APNs payload: `{ aps: { alert, badge, sound }, link: "https://compose.grepawk.com/inbox/<handle>" }`. No email notifications.

## Client behavior (web + iOS)

- **Feed audio switch:** `FADE_OUT_MS = 58`. The next song starts immediately at full volume (no fade-in, no waiting). The previous song fades out over 58 ms with gain `cos(t·π/2)`, `t` from 0 to 1.
- The fade starts when the scroll settles on a snapped card (web: `scrollend`, or 120 ms without scroll events). It does not start while the user is still scrolling.
- At most one voice fades out at a time. A new switch during a fade stops the stale fading voice at once, so audio never piles up.
- Preload the active card's audio plus the next and previous cards.
- The first tap unlocks audio (iOS). After that, settling on a card autoplays it. Pause everything when the tab or app is hidden.
- Web applies gain through Web Audio GainNodes, because iOS Safari ignores `HTMLMediaElement.volume`.

- **Active card visuals (only the active card animates):**
  - Row 1 is a piano roll windowed like Export video (the shared `drawRoll`). `PLAYHEAD_X = 0.25` of the width, `WINDOW_SEC = 4`. Only the notes sounding now and the next few seconds are drawn, scrolling toward the playhead.
  - Sounding notes are lit with a brighter track color: mix the color toward white by 0.45 in light mode, 0.35 in dark, plus the `--so-note-outline` stroke. Past notes use alpha 0.35, upcoming notes 0.75. At least 12 pitch rows.
  - Row 2 is split. Left: `BARS = 48` log-spaced spectrum bars from 40 Hz to 16 kHz (AnalyserNode `fftSize` 2048, smoothing 0). Each bar takes the max bin, with instant attack and exponential decay `exp(-dt/150ms)`, colored with a gradient from `--so-spec-from` to `--so-spec-to`. Right: a time-domain waveform oscilloscope in `--so-wave`.
  - The audio loops, so the roll wraps (notes repeat at ±duration). Animation runs with requestAnimationFrame while the card is playing and the tab is visible; bars go flat when paused. Canvases render at devicePixelRatio (capped at 3).
- **Palette:** light is the default; dark follows `prefers-color-scheme: dark`. Canvas colors are read from these CSS vars (on `.so-app`). Dark values follow the iOS asset colour sets (BackgroundTop, Surface, TextPrimary/Secondary, AccentColor, Border, Chip, RollRow, Playhead, BarStart/BarEnd, Waveform, Destructive):

| Var | Light | Dark |
|---|---|---|
| `--so-overlay` | `rgba(255,255,255,.92)` | `rgba(22,40,58,.92)` |
| `--so-scrim` | `rgba(17,35,49,.4)` | `rgba(0,0,0,.6)` |
| `--so-accent` | `#2d6a93` | `#61a6d1` |
| `--so-roll-bg` | `#f8fcff` | `#0f1d2a` |
| `--so-border-strong` | `#c9dbe8` | `#26425a` |
| `--so-text` | `#16324a` | `#e6f0f8` |
| `--so-border` | `#d5e5f0` | `#26425a` |
| `--so-chip` | `#eef3f7` | `#1c3247` |
| `--so-border-hover` | `#b6cfe1` | `#3b4f61` |
| `--so-dim` | `#5f7a90` | `#93acc0` |
| `--so-ok-bg` | `#eefbf8` | `#10302a` |
| `--so-sel-bg` | `#d5e7f5` | `#173149` |
| `--so-ok-border` | `#9fd3c9` | `#2f6f62` |
| `--so-accent-2` | `#61a6d1` | `#4c9bd6` |
| `--so-warn-bg` | `#fff4d6` | `#3a2e10` |
| `--so-bg` | `#fdfefe` | `#0b1620` |
| `--so-warn-border` | `#f0c96a` | `#7a6020` |
| `--so-star` | `#f0a020` | `#ffc94d` |
| `--so-hover` | `#e7f0f7` | `#1c2630` |
| `--so-sel-2` | `#e3eff8` | `#1a2e42` |
| `--so-divider` | `#e3eef6` | `#222c36` |
| `--so-muted-border` | `#c9d6e0` | `#34414d` |
| `--so-danger` | `#bf1f2f` | `#ff6b81` |
| `--so-warn-text` | `#8a5a00` | `#f0c96a` |
| `--so-ok-text` | `#1f6f60` | `#5fd3bb` |
| `--so-surface` | `#fff` | `#16283a` |
| `--so-roll-row` | `#e3ecf4` | `#132433` |
| `--so-roll-grid` | `#e3edf5` | `#1b242e` |
| `--so-roll-bar` | `#c9dbe8` | `#2a3644` |
| `--so-playhead` | `#ff4081` | `#ff5c93` |
| `--so-note-outline` | `#16324a` | `#ffffff` |
| `--so-key-white` | `#f7f7f7` | `#c9d1d9` |
| `--so-key-black` | `#3a3f4a` | `#21262d` |
| `--so-spec-from` | `#39b2ef` | `#4cbaf0` |
| `--so-spec-to` | `#ef3976` | `#f25f90` |
| `--so-wave` | `#2d6a93` | `#9fd3c9` |

## Rate limits

Per user + IP, in-memory: comments 10/min, ratings 60/min, DMs 20/min, reports 10/hour, plays 120/min.
