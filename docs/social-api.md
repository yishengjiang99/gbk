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
  "preview": { "notes": [[pitch, start, dur, track]], "duration": 32.0 }, // piano-roll preview, may be null
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

## In-app purchases — Apple (spec; implementation follows)

Products (bundle `com.grepawk.moviefone`, see `docs/asc/iap.md`) all grant the same `pro` entitlement as Stripe Pro.

| productId | type | Stripe equivalent |
|---|---|---|
| `com.grepawk.moviefone.pro_monthly` | auto-renewable, group "GBK Pro" | `pro_monthly` |
| `com.grepawk.moviefone.pro_yearly` | auto-renewable, group "GBK Pro" | `pro_yearly` |
| `com.grepawk.moviefone.lifetime` | non-consumable | `lifetime` |

`pro` means 10× the Studio composer-agent daily token budget (2M vs 200k) and 120 server renders per hour of up to 600 s (vs 30/h, 300 s).

### `POST /api/iap/apple`

Auth: optional Bearer. A guest or signed-in session is fine; with no auth the purchase is linked only by `app_account_token`.

Body: `{ "signed_transaction": "<StoreKit 2 JWSTransaction>", "app_account_token": "<uuid>" }`.

Verification:
- The JWS header `x5c` chain must verify up to **Apple Root CA - G3**. The root certificate is pinned in the repo at `server/certs/AppleRootCA-G3.cer`. Each certificate must be within its validity window, and the leaf must carry the Apple Mac App Store receipt-signing OID `1.2.840.113635.100.6.11.1`.
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

Pro from either source lifts the agent token budget and render limits.

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
