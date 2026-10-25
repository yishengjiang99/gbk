# gbk Social API (v1 contract)

Base URL: `https://compose.grepawk.com`. JSON in and out (`content-type: application/json`), UTF-8.
This is the contract the web app and the native iOS client both build against. Each endpoint is tagged with the
phase that ships it: **P1** schema, profiles/handles, publish, ratings, comments, Feed API/UI, reports;
**P2** feed ranking polish/filters UI; **P3** prompt sharing + Remix; **P4** DMs/inbox/blocks; **P5** notifications + APNs;
**iOS-1** native auth exchange. Endpoints not yet live return `404`.

## Conventions

- **Auth.** Either the web session cookie (`gbk_session`, set by Google/GitHub OAuth at `/api/auth/:provider`) or
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
  `GET /.well-known/apple-app-site-association` (iOS-1) lists paths `/s/*`, `/u/*`, `/t/*` for the app id.
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
  "media": { "mp3": "https://…/api/shares/<slug>/media/mp3", "midi": "https://…/media/midi" }, // null when absent
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

Every `/api/*` route accepts `Authorization: Bearer <access_token>` (P1: bearer = server session token; write routes skip Origin/CSRF for bearer).
Tokens are minted by the existing `/oauth` token machinery (same signing, same `user` id as web accounts).

| Method + path | Phase | Notes |
|---|---|---|
| `GET /api/session` | live | `{ user, csrf, me }` (web) |
| `POST /api/auth/apple` | iOS-1 | `{ identityToken, nonce, displayName? }`. Verifies Apple JWT (JWKS, `aud` = bundle id, `sha256(nonce)` = claim). → `TokenPair` |
| `POST /api/auth/google/native` | iOS-1 | `{ idToken }` (`aud` = iOS client id). → `TokenPair` |
| `POST /api/auth/refresh` | iOS-1 | `{ refresh_token }` → `TokenPair` (rotating; old refresh token revoked) |
| `POST /api/auth/logout` | iOS-1 | revokes the presented access + refresh tokens |
| `POST /api/auth/web-code` | iOS-1 | bearer → `{ code, expires_in: 60 }` one-time code |
| `GET /api/auth/web-code/redeem?code=&return=/studio` | iOS-1 | sets the cookie session in the WKWebView, 302 to `return` (same-origin path only). Single use, 60 s |
| `DELETE /api/me` | iOS-1 | deletes account, songs, comments, ratings, messages, devices; → `{ ok: true }` (App Store 5.1.1(v)) |

`TokenPair` = `{ access_token, token_type: "Bearer", expires_in: 3600, refresh_token, me: Me }`.
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
| `GET /api/shares/:slug` | anyone (public) / owner | Song detail (`project` included for the studio) |
| `PATCH /api/shares/:slug` | owner | `{ title?, public?, labels?, tags?, prompt_shared?, prompt_text? }` → Song |
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
| `POST /api/push/register` | signed-in | `{ installId, token: "<APNs hex>", environment: "production|sandbox" }` → `{ ok }` (upsert by installId; modeled on earsheet devices.ts) |
| `POST /api/push/unregister` | signed-in | `{ installId }` → `{ ok }` (call on logout) |

APNs sender (token-based .p8 auth, ported from earsheet apns.ts) fires on new DM, comment on your song, fork of your song.
APNs payload: `{ aps: { alert, badge, sound }, link: "https://compose.grepawk.com/inbox/<handle>" }`. No email notifications.

## Rate limits

Per user + IP, in-memory: comments 10/min, ratings 60/min, DMs 20/min, reports 10/hour, plays 120/min.
