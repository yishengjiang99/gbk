# gbk Social status

## iOS

Native SwiftUI client in `ios/` (XcodeGen, iOS 17). CI: `.github/workflows/ios.yml` (macOS, simulator build + unit tests, unsigned).

| Area | State |
|---|---|
| M0 scaffold (tabs, theme, API client, Keychain auth store, push manager, feed player, deep links, studio web view) | done |
| Feed: `GET /api/feed` cursor paging, For you/New/Top chips, label menu, tag filter, `/t/<tag>` deep link | done (live API) |
| Play counting `POST /api/shares/:slug/play` | done (live API) |
| Ratings (stars, tap again to clear, double-tap = 5) | done (live API) |
| Comments sheet (flat, post, delete own, report) | done (live API) |
| Report sheet `POST /api/reports` | done (live API) |
| Block `POST /api/blocks/:handle` | wired; route is P4, shows "not available" on 404 |
| Profile: `GET /api/me` + `GET /api/users/:handle` | done (live API; `/api/me` needs a token) |
| Native auth (Apple/Google exchange, refresh, logout), web-code handoff, `DELETE /api/me`, push register | behind `AuthServicing`: `LiveAuthService` calls the specced routes; `MockAuthService` for tests. Routes 404 on prod today |
| sf2player-swift `SF2Engine` dependency | added (pinned 6ce4941), not used yet |
| Inbox/DMs | placeholder (P4) |

### Doc vs prod (checked 2026-10-25 against prod 44b3be2)

- `preview`: prod sends `{ tracks: [color], lo, hi, end, notes: [[trackIndex, start, length, pitch]] }`; the doc says `{ notes: [[pitch, start, dur, track]], duration }`. The iOS model accepts both.
- `GET /api/session` returns `{ authenticated, user, name, provider, csrf, enabled, providers, loginAvailable, reviewerLogin, limits }`, not `{ user, csrf, me }`.
- 404s for unbuilt routes use Fastify's `{ message, error, statusCode }`, not `{ code, message }`.
- `/t/<tag>` is a tag deep link (the M0 app treated it as a thread; fixed).
