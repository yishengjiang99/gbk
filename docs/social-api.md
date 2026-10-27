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
- **Errors.** `{ "code": "UPPER_SNAKE", "message": "human text" }` with HTTP 400/401/403/404/409/413/422/429.
  `401 UNAUTHENTICATED`, `403 FORBIDDEN|BLOCKED|DMS_OFF`, `404 NOT_FOUND`, `422 INVALID_*`, `429 RATE_LIMITED` (+ `retry-after` seconds).
- **Pagination.** Cursor based: response has `next_cursor` (opaque string, `null` at end). Pass `?cursor=<next_cursor>`; `limit` 1–50, default 20.
- **Time.** Epoch milliseconds (`created_at`, …), UTC.
- **IDs.** Songs are addressed by `slug`; users by `handle` (lowercase `a-z0-9_`, 3–20). Comments/messages by numeric-string `id`.
- **Cursor format.** `next_cursor` is an opaque base64url string; never parse or build it. Same filters must be resent with it.
- **Backward compatibility.** `GET /api/shares` (offset pagination, camelCase `ShareView`) stays unchanged; new social fields live only on the new endpoints.
- **Deep links.** `https://compose.grepawk.com/s/<slug>` (song), `/u/<handle>` (profile), `/t/<tag>` (tag), `/inbox/<handle>` (DM thread).
  `GET /.well-known/apple-app-site-association` (live; app id `83D36RPMUM.com.grepawk.moviefone` by default, override with `IOS_APP_IDS`, set it empty to disable) (also at `/apple-app-site-association`, JSON, no redirect) lists paths `/s/*`, `/u/*`, `/feed*`, `/t/*` for the app id, plus legacy `appID`/`paths` entries for older iOS. Smart App Banner (`apple-itunes-app`) is not emitted until a numeric App Store id exists.
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
  "preview": { "notes": [[pitch, start, dur, track]], "duration": 32.0 }, // piano-roll preview, may be null
  "prompt_shared": false, "prompt_text": null,   // P3; text only when owner opted in
  "parent_slug": null, "is_mine": false
}

// Comment
{ "id": "17", "author": User, "body": "nice", "created_at": 0, "can_delete": false }
```

Labels (fixed set, max 3): `ambient lofi classical jazz rnb electronic cinematic game pop experimental wip`.
Tags: max 10, lowercase `a-z0-9-`, 2–24 chars.

## Auth & session (iOS-1 unless noted)

Every `/api/*` route accepts `Authorization: Bearer <access_token>` (live since P1: bearer = the web session token value; write routes skip Origin/CSRF for bearer).
Tokens are minted by the existing `/oauth` token machinery (same signing, same `user` id as web accounts).

| Method + path | Phase | Notes |
|---|---|---|
| `GET /api/session` | live | `{ user, csrf, me }` (web) |
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

### Guest accounts (iOS; live)

Reads need no auth: `GET /api/feed`, `/api/tags/top`, `/api/tags/:tag`, `/api/songs/:slug`, `/api/users/:handle`, `/api/shares/:slug/comments`, plus the `/s/<slug>`, `/u/<handle>` and `/t/<tag>` pages.
Reads with a guest or full bearer add viewer fields (`my_rating`, `is_mine`, `can_delete`).

`POST /api/auth/anonymous` (no auth): `{ deviceId, username }` → `{ token, refreshToken, user, ...TokenPair }`.
- `token` = `access_token`, `refreshToken` = `refresh_token`, `user` = `me`. Both naming styles are present. Refresh and logout work as for other tokens.
- `deviceId`: 16–128 chars of `[A-Za-z0-9-_]`, e.g. `identifierForVendor` or a Keychain UUID. The server stores only an HMAC of it.
- `username`: exactly two capitalized English words, letters only, no digits or spaces, 4–20 chars. Regex `^[A-Z][a-z]{1,11}[A-Z][a-z]{1,11}$`, e.g. `MellowFox`. Blocklisted words → `422`.
  - `display_name` = `MellowFox`, `handle` = `mellowfox` (lowercase). `me.provider` = `"guest"`, `me.is_guest` = `true`.
- **Idempotent per device:** a known `deviceId` returns its existing guest with fresh tokens. The `username` is then ignored, never 409.
- **Collision:** a new device whose handle is taken (by anyone) gets digits appended: `mellowfox2`, `mellowfox3`, … up to `mellowfox999`. `display_name` stays `MellowFox`; the final handle is in `user.handle`. Only if all 998 suffixes are taken → `409 HANDLE_TAKEN`; pick another combo and retry.
- **Errors:** invalid input → `422 { code: "INVALID_USERNAME" | "INVALID_DEVICE", message, error, statusCode }`.
- **Rate limit:** 5 new guests per IP per hour and 20 calls per IP per hour; idempotent repeats count toward the 20. Over the limit → `429` with `retry-after`.
- **Guest permissions:**
  - Allowed: play, rate, comment (comments 20/day), report, block.
  - Allowed: edit display name or handle via `PATCH /api/me/settings`, under the same two-word rule while still a guest. Set `dm_policy`. `DELETE /api/me`.
  - Allowed: publishing public songs (see **Guest publish** below).
  - Not allowed: sending DMs (`403 GUEST_LIMITED`), receiving DMs from others (guests behave as `dm_policy: "off"`), and push for DMs. Comment and rating push works after `POST /api/push/register`.
  - Sign in with Apple or Google to lift the limits.

### Guest publish (iOS; live)

Guests publish like anyone else: `POST /api/shares` with `public: true`, or `PATCH /api/shares/:slug { public: true }`, with the guest bearer (app) or the guest cookie session (web view).
- **Limits:** 10 public publishes per guest account (one per device) and 30 per IP, per rolling 24 h. Over → `429 { code: "GUEST_PUBLISH_LIMIT", message, error, statusCode }` with `retry-after` (seconds). Private saves and the normal share limits are unchanged. Signed-in accounts are not affected.
- Reports, admin hide/unpublish and blocks apply to guest songs and guest users exactly as to other accounts.

**Web-view guest session.** The studio web view has no cookie until the user signs in. In the app (`window.gbkNative` exists) the web Publish action does this, with no sign-in sheet and no `gbk:need-signin` event:
1. Without a session it first calls `POST /api/auth/guest/web` (below).
2. It saves the song privately, exactly like the studio autosave: it creates the share if none exists yet, otherwise it updates it. If the save fails, it shows a short error and stops; no message is posted.
3. After the save finishes, if `webkit.messageHandlers.publish` exists, it calls `postMessage({ projectId, slug, title, labels: [], tags: [] })` and stops; the app shows its native publish sheet. `projectId` is the studio project id; `slug` is the saved share (still private, `public: false`), to publish with `PATCH /api/shares/:slug { public: true }` and `PATCH /api/songs/:slug/meta`; `title` is the saved title.
4. Otherwise it opens the web publish sheet for that share.

**Composer runs across tab switches.** A composer run survives the web view being hidden or its socket dropping (tab switch, app background). When the page is visible again (`visibilitychange`, `pageshow`, `online`) it reconnects and re-attaches to the in-flight run by run id; the server replays outstanding tool calls. A detached run is held for `AGENT_RECONNECT_GRACE_MS` (default 300 s). A new page load (reload, `/studio?new=<n>`) cannot re-attach: the in-flight run ends at once with a short "page reloaded or closed" message; changes already applied stay saved.

`POST /api/auth/guest/web` (no body)
- Headers: `X-GBK-Device: <UUID v4>` (the per-install random id the app keeps in the Keychain; any case) and `X-GBK-Guest-Name: <two-word username>` (same rule as `username` above). Same-origin `Origin` required (`403 BAD_ORIGIN`).
- The web page reads both from `window.gbkNative.deviceId` and `window.gbkNative.guestName`, which the app injects. Send the **same device id string** as `deviceId` to `POST /api/auth/anonymous`: the server keys the guest on `HMAC-SHA256(SESSION_SECRET, "gbk-guest-device:" + id)`, so the app bearer and the web cookie are the same guest account. The raw id is never stored.
- `200 { me, created }`, plus `Set-Cookie` for the session and `gbk_csrf`. A known device returns its existing guest (the name is ignored). A collision appends digits, as above; read the final handle from `me.handle`. With a full (non-guest) session already present, it returns that `me` and changes nothing.
- Errors: `422 INVALID_DEVICE` (not a UUID v4), `422 INVALID_USERNAME`, `409 HANDLE_TAKEN` (all suffixes taken), `429 RATE_LIMITED` with `retry-after`. It shares limits with `/api/auth/anonymous`: 20 calls and 5 new guests per IP per hour.
- Treat the device id as a credential: anyone who has it can act as that guest. Never log or display it.

**Upgrade on sign-in.** `POST /api/auth/apple` and `POST /api/auth/google/native` accept an optional `Authorization: Bearer <guest access token>`.
- If the bearer is a valid guest and the Apple/Google identity has **no** account yet, the guest account is upgraded in place. Same user id, handle, display name, ratings, comments, blocks and devices; the Apple/Google identity is attached and `is_guest` becomes `false`. All the guest's refresh tokens are revoked and a new `TokenPair` is returned with `upgraded: "linked"`.
- If the identity **already** has an account, that account wins and is returned (`upgraded: "merged"`).
  - The guest's ratings move over unless that account already rated the same song.
  - The guest's songs (public and private), comments, reports, blocks (made and received) and push devices are re-owned by that account.
  - The guest account and its handle are then deleted, and every guest session (bearer and web-view cookie) is revoked. The trigger is the guest bearer on the sign-in call; repeating it with the now-dead bearer is a plain sign-in (`upgraded` absent), so carry-over runs once and is idempotent.
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
- **Feed section switch** (For you / New / Top / label / #tag chip, or a Browse pick): the playing song fades out over the same 58 ms at once, and the new section starts at its first card (scroll to top, first card focused, autoplay from card 0 once unlocked).
- **Create entry / `window.gbkStudio`** (web studio; iOS reads it from the Create web view):
  - `gbkStudio.currentProject()` returns `{ id: string, title: string, published: boolean, dirtySincePublish: boolean, hasContent: boolean, updatedAt: number | null }`. `published` is true when this project was published (this device's publish record, or one of my public songs with the same project id or title). `dirtySincePublish` is true when it was edited after that publish. `hasContent` is true when the project has notes and is my own editable project (not a read-only share). `updatedAt` is epoch ms of the last local edit or save, or null.
  - Rule: Create resumes the current project only when `hasContent && (!published || dirtySincePublish)`. Otherwise it opens `/studio?new=<timestamp>`, which starts a blank project. A published, unedited project counts as done.
  - `gbkStudio.shouldResume()` applies the rule. `gbkStudio.createPath()` resolves to `"studio"` or `"studio?new=<ts>"` after a short check of my public songs. `gbkStudio.flushSave(): Promise<void>` saves the current project now (local IndexedDB and, when signed in, the server autosave) and resolves when done; the page also calls it on `pagehide` and on `visibilitychange` to `hidden`. `gbkStudio.startNew()` saves the current project locally and starts a blank one (the studio's **New** button). `gbkStudio.recentProjects()` returns `[{ id, title, savedAt }]`, newest first, and `gbkStudio.openRecent(id)` opens one.

## In-app purchases — Apple (live)

Products (bundle `com.grepawk.moviefone`, see `docs/asc/iap.md`) all grant the same `pro` entitlement as Stripe Pro.

| productId | type | Stripe equivalent |
|---|---|---|
| `com.grepawk.moviefone.pro_monthly` | auto-renewable, group "GBK Pro" | `pro_monthly` |
| `com.grepawk.moviefone.pro_yearly` | auto-renewable, group "GBK Pro" | `pro_yearly` |
| `com.grepawk.moviefone.lifetime` | non-consumable | `lifetime` |

`pro` means 10× the Studio composer-agent daily token budget (2M vs 200k). Planned, not yet enforced: 120 server renders per hour of up to 600 s (vs 30/h, 300 s); see TODO.

### `POST /api/iap/apple`

Auth: optional Bearer. A guest or signed-in session is fine; with no auth the purchase is linked only by `app_account_token`.

Body: `{ "signed_transaction": "<StoreKit 2 JWSTransaction>", "app_account_token": "<uuid>" }`.

Verification:
- The JWS header `x5c` chain must verify up to **Apple Root CA - G3**. The root certificate is pinned in the repo at `server/certs/AppleRootCA-G3.cer`; it is embedded in `server/src/iap/apple-root.ts` because the server ships as one bundle, and a test checks that both hold the same bytes. Each certificate must be within its validity window, and the leaf must carry the Apple Mac App Store receipt-signing OID `1.2.840.113635.100.6.11.1`.
- `alg` is `ES256`. The signature is checked with the leaf key.
- Payload: `bundleId == "com.grepawk.moviefone"`, `productId` must be one of the three above, and `appAccountToken` (when present in the payload) must equal `app_account_token`.
- **Environment:** `Production` is always accepted. `Sandbox` / `Xcode` is accepted only when the server runs with `IAP_ALLOW_SANDBOX=1`. That is the default off production, and on production it allows App Review / TestFlight sandbox purchases.
  - Sandbox entitlements are stored with `environment: "Sandbox"` and shown in `/api/me` as `pro_environment`.
- **Ownership:**
  - With a bearer, the purchase attaches to the caller's account (guests too).
  - Without one, it attaches to the account already linked to that `app_account_token`, or stays pending: stored and claimed by the first account that later posts the same token.
  - A transaction (`originalTransactionId`) or `app_account_token` already owned by a **different** account → `409 { code: "IAP_OWNED_BY_OTHER", message, error: "Conflict", statusCode: 409 }`.
- **Idempotent** on `transactionId`: reposting returns the same answer.

Responses:
- `200 { "entitlements": ["pro"] | [], "expires_at": <unix ms> | null, "product_id", "environment" }`. `expires_at` is null for lifetime. A revoked/refunded or expired transaction → `entitlements: []`.
- `400 { code: "INVALID_JWS" | "WRONG_BUNDLE" | "UNKNOWN_PRODUCT" | "SANDBOX_NOT_ALLOWED" | "TOKEN_MISMATCH", message, error, statusCode }`.
- Rate limit: 30/min per IP and 10/min per account → `429`.

### `POST /api/iap/apple/notifications`

App Store Server Notifications **v2**. The same URL is used for production and sandbox in App Store Connect.

Body: `{ "signedPayload": "<JWS>" }`. Verified as above; the nested `signedTransactionInfo` and `signedRenewalInfo` are verified too.

Idempotent on `notificationUUID`: repeats → `200` with no change. Handling:
- `SUBSCRIBED`, `DID_RENEW`, `OFFER_REDEEMED`: update `expires_at` and set active.
- `DID_FAIL_TO_RENEW`: with subtype `GRACE_PERIOD`, active until `gracePeriodExpiresDate`; otherwise no change until expiry.
- `GRACE_PERIOD_EXPIRED`, `EXPIRED`: inactive.
- `REFUND`, `REVOKE`: set `revoked_at`, inactive.
- `DID_CHANGE_RENEWAL_STATUS`, `DID_CHANGE_RENEWAL_PREF`: store `auto_renew` (informational).
- Others: logged, `200`.

Mapping to an account uses `originalTransactionId`, then `appAccountToken`. Invalid JWS → `400`, so Apple retries only on non-2xx.

### Entitlements in `GET /api/me`

`Me` gains `pro: boolean`, `pro_source: "stripe" | "apple" | null`, `pro_expires_at: <unix ms> | null` and `pro_environment: "Production" | "Sandbox" | null`. This applies to guests too.

`pro_source: "stripe"` comes from an active Stripe subscription on grepawk.com (looked up by verified account email, cached 10 min; see `server/src/billing/stripe-pro.ts`). Stripe Pro carries no `pro_expires_at`/`pro_environment`.

`Me` also has (#115) `usage: { compositions, ai_runs, renders, exports, shares, paywall_views, last_paywall_at }` (lifetime counts) and `paywall: { eligible, reason: "second_composition" | "export_after_2" | "ai_limit" | "render_limit" | null, cooldown_until: <unix ms> | null }`. Pro is never eligible; a dismiss starts a 24 h cooldown. `POST /api/me/engagement {event: "paywall_view" | "paywall_dismiss" | "export"}` (CSRF like other writes) records an impression, a dismissal or a client-side WAV/MIDI export and returns `{usage, paywall}`. None of this is exposed through MCP/ChatGPT.

Pro from either source lifts the agent token budget and render limits.

The public `User` object (profile payloads and every `Song.author`) also gains `pro: boolean` (#133) — the same unified entitlement as a bare flag, shown as a Pro badge on profiles and feed cards. Source, expiry and environment are never exposed publicly; those stay on `Me` only.

Guest → Apple/Google upgrade or merge carries Apple entitlements over: purchases move to the surviving account.

`DELETE /api/me` detaches purchases from the account. They stay re-claimable by `app_account_token` / Restore.

No App Store Server API key is needed for JWS verification. An In-App Purchase key would only be needed later for lookups or refund history.

## Rate limits

Per user + IP, in-memory: comments 10/min, ratings 60/min, DMs 20/min, reports 10/hour, plays 120/min.

## Feed events (impressions)
`POST /api/events` body `{session, client, events:[{song, dwell_ms, listen_ratio, completed, fast_skip?, actions?, model_version, position, feed?}]}`. It returns `{accepted}`.
- Actor: the session user, else the `gbk_gid` cookie or the `x-gbk-install` header.
- Limits: ≤50 events per batch, 30 batches/min per actor.
- `GET /api/feed` (For you, unfiltered) accepts `session=` and returns `model_version` (`heur-2` or `lr-YYYYMMDD`).
- Admin: `GET /api/admin/metrics?days=7`.

See docs/social/ranking.md.

### Owner "delete" report shortcut (live)
`POST /api/reports` from the account whose handle is `@yishengjiang` (matched by that profile's user id, not display name, not other admins) with `reason` equal to `delete` (trimmed, case-insensitive) on a `comment` or `song` hides it at once (comment `hidden` flag / song unpublished; reversible by the admin queue or republishing), resolves its open reports, and answers `{ ok, id, deleted: true, message: "Deleted" }`. Anyone else filing "delete" gets a normal report.
