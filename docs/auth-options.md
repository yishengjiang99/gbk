# Auth options: Sign in with Apple, SMS sign-in, linking, sessions

Status: proposal (2026-10-25). Nothing here is implemented.

## Today (what this must fit)
- `server/src/routes/signin.ts`: server-side OAuth code flow for GitHub and Google (Google uses PKCE; state + verifier in a
  single-use `gbk_oauth_state` cookie, SameSite=Lax). Callback -> `accounts.upsertOAuth(provider, providerId, name, email)`
  -> `sessions.create(account.id)`. Google email is stored only when `email_verified`.
- `server/src/persistence/accounts.ts`: one row per `(provider, provider_id)`; no identity/link table, so a person who uses
  Google and GitHub today gets two accounts.
- `server/src/security/authentication.ts`: opaque server-side sessions in SQLite (SHA-256 of id stored), HMAC-signed
  `gbk_cs` cookie, HttpOnly, SameSite=Strict, 30-day sliding TTL, CSRF double-submit (`gbk_csrf` + `x-gbk-csrf`).
- `server/src/mcp/oauth.ts` / `mcp/auth.ts`: an OAuth 2.1 authorization server already issues Bearer tokens (user, scopes,
  audience) for MCP. Reusable for iOS.
- Unknown: there is no iOS app in this repo; the iOS bundle ID and how it ships are not known.

## 1. Sign in with Apple (web + iOS)
Apple Developer setup: an App ID with the Sign in with Apple capability (the iOS app, primary), a **Services ID** (web
`client_id`, grouped under that App ID) with domain `<public origin host>` and return URL
`${publicOrigin}/api/auth/apple/callback`, and a **Sign in with Apple key (.p8)** with its Key ID + Team ID. Domain
verification: older docs require hosting Apple's `apple-developer-domain-association.txt` under `/.well-known/`; whether
that is still required is **unverified** - follow what the portal shows.

- Web: add `apple` to `ProviderName` in `signin.ts`. Authorize at `https://appleid.apple.com/auth/authorize` with
  `response_type=code`, `scope=name email`. When scopes are requested Apple requires `response_mode=form_post`, so the
  callback must accept **POST** and the state cookie must survive a cross-site POST (needs `SameSite=None; Secure`, not Lax).
  Exchange the code at `https://appleid.apple.com/auth/token` with a `client_secret` that is an ES256 JWT signed by the
  .p8 key (iss=Team ID, sub=Services ID, aud=`https://appleid.apple.com`, max 6 months).
- iOS: `ASAuthorizationAppleIDProvider` returns `identityToken` + `authorizationCode`; app POSTs them to a new
  `POST /api/auth/apple/native`. Its `aud` is the **bundle ID**, not the Services ID.
- One account: Apple's `sub` is stable per Team, so web (Services ID) and iOS (App ID) give the same `sub` when grouped
  under the same primary App ID. Key the account on `("apple", sub)` and accept `aud` in {Services ID, bundle ID}.
- Server-side ID token check (both paths): fetch JWKS `https://appleid.apple.com/auth/keys`, verify RS256 signature,
  `iss == https://appleid.apple.com`, `aud` allowed, `exp`, and a `nonce` we issued (hash) to stop replay. Name is sent only
  on the first authorization - store it then.
- Revocation: Apple requires in-app account deletion to call `https://appleid.apple.com/auth/revoke`; keep the refresh
  token from the code exchange for that.

## 2. SMS sign-in
Public US pricing checked 2026-10-25 (verify again before signing up):

| Option | US cost per verification (1 SMS) | Notes |
|---|---|---|
| [Twilio Verify](https://www.twilio.com/en-us/verify/pricing) | $0.05 per successful check + $0.0083 per SMS = ~$0.058 | No base fee on failed checks, but SMS sends are always billed. Fraud Guard (SMS pumping), rate limits, number pool, templates included. No 10DLC registration needed by us. |
| [Vonage Verify](https://www.vonage.com/communications-apis/verify/pricing/) | $0.06084 (EUR 0.052) per success + messaging rates (US rate not shown) | Fraud Defender included. Total **unknown**. |
| [Telnyx Verify](https://telnyx.com/pricing/verify-api) | $0.03 per success + SMS API price (SMS "from $0.004/part"); headline "from $0.05" | Carrier passthrough extra; total **unknown** for US. |
| [Firebase / Identity Platform phone auth](https://cloud.google.com/identity-platform/pricing) | $0.01 per SMS sent (US); first 10/day free | Cheapest; adds a Firebase client SDK + reCAPTCHA/App Check on web and iOS and a second identity system to bridge to our sessions. |
| AWS End User Messaging / SNS ([pricing](https://aws.amazon.com/end-user-messaging/pricing/)) | ~$0.00774 + $0.00421 carrier fee per US part (from a [third-party summary](https://proofyo.com/products/aws-end-user-messaging); AWS page needs JS) | DIY: we generate/store codes. Needs 10DLC or toll-free registration, sandbox exit. Cognito not priced here (**unknown**). |
| MessageBird / Bird | **unknown** - pricing not checked | - |

Abuse defenses (needed whichever provider):
- SMS pumping/toll fraud: **country allowlist** (start US/CA only), reject premium/unknown ranges, watch send-to-verify
  ratio per country, provider fraud guard on, hard daily spend cap/alert in the provider console.
- Rate limits via existing `security/rate-limit.ts`: per IP (e.g. 5 sends/hour), per phone (3/15 min, 10/day), per
  country, plus a global sends/hour circuit breaker. Max ~5 code checks per code.
- Captcha (e.g. Turnstile) before the send call on web; App Attest/DeviceCheck on iOS (**to be decided**).
- E.164-normalize numbers; same generic response whether the number is new or known.

**Recommendation: Twilio Verify.** ~$0.058 per US verification is a few cents more than DIY/Firebase, but it owns code
generation, expiry, the sender number and pumping protection, and keeps everything server-side in our existing Fastify +
session model (two calls: `Verifications` create, `VerificationCheck`). Revisit Firebase if volume makes cost matter.

## 3. Account linking
- Add an `identities(provider, provider_subject, account_id, email, email_verified, phone_e164)` table; `accounts` keeps
  the profile. Migrate existing rows 1:1.
- Auto-link only on a **verified** identifier owned by the provider: Google `email_verified=true`, Apple `email_verified`
  true, Twilio-verified phone. GitHub email today is the public profile email (not verified) - never link on it.
- Apple private relay (`@privaterelay.appleid.com`) never matches another provider; treat as a contact address only.
- Never link an incoming identity onto an existing account by email alone when that account was itself created from an
  unverified email. Safer default: when emails match, ask the user to sign in with the existing method first, then link
  from a logged-in "Linked accounts" page (explicit link = both sessions proved). Unlinking requires >=1 remaining method.

## 4. Sessions
- Web: unchanged - `gbk_cs` cookie + CSRF. Apple web callback ends on the same same-origin hop page as Google.
- iOS: Bearer tokens, no cookies. `POST /api/auth/apple/native` and `POST /api/auth/sms/verify` return
  `{ access_token (short, e.g. 1 h), refresh_token (opaque, ~30 d, rotating) }`, stored only as hashes server-side (same
  pattern as `web_sessions`). Prefer reusing the MCP token store/audience checks instead of a third token kind.
- `POST /api/auth/token` (`grant_type=refresh_token`): rotate; reuse of an old refresh token revokes the whole family.
- `POST /api/auth/revoke` + logout-everywhere (delete all sessions/tokens for the account). Account deletion also calls
  Apple revoke.

## 5. Blockers (need Yisheng's accounts/keys)
1. Apple Developer Program membership (paid, Team ID) - status **unknown**.
2. Create App ID (iOS bundle ID - unknown) with Sign in with Apple; create Services ID; register domain + return URL;
   complete domain verification if the portal asks.
3. Create Sign in with Apple key, download the .p8 once, give Key ID; put `APPLE_TEAM_ID`, `APPLE_SERVICES_ID`,
   `APPLE_BUNDLE_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` into the server env file (never in git).
4. Twilio account signup, upgrade from trial with billing (card), create a Verify Service, enable Fraud Guard, set geo
   permissions (US/CA) and a spend alert; provide `TWILIO_ACCOUNT_SID`, API key/secret, `TWILIO_VERIFY_SID`.
5. Captcha site/secret key (e.g. Cloudflare Turnstile) - needs an account.
6. Decision: which countries to allow at launch; privacy page (`routes/pages.ts`) text for Apple + phone numbers.
