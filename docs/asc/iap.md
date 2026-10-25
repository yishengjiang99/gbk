# GBK Pro in-app purchases (App Store)

Translates the Stripe "GBK Composer Pro" catalog (docs/stripe.md, product `prod_VVXpcLHC6Ahg5t`) into App Store IAPs for
"GBK Music Composer" (Apple ID 6826906431, bundle `com.grepawk.moviefone`). There are no consumable credit packs in
Stripe; all three tiers grant the same `pro` entitlement. Source of truth for IDs/prices: `ios/StoreKit/GBKComposer.storekit`
(used by Xcode for local testing, by `StoreTests`, and by `docs/asc/scripts/push_iap.py`).

| Stripe tier (price ID) | Stripe price | IAP type | productId | Reference name | App Store price point (USA) | Display name / description | Entitlement |
|---|---|---|---|---|---|---|---|
| GBK Pro Monthly `price_1UUWjt4OymfcnKESqqY2SpC4` (plan=pro_monthly) | $5.99 / month, 7-day trial | Auto-renewable, group "GBK Pro", level 2, 1-week free-trial intro offer | `com.grepawk.moviefone.pro_monthly` | GBK Pro Monthly | $5.99 | GBK Pro Monthly / "10x Studio budget and longer renders, billed monthly." | `pro` while active |
| GBK Pro Yearly `price_1UUWjt4OymfcnKESKn99TpqY` (plan=pro_yearly) | $47.99 / year, 7-day trial | Auto-renewable, group "GBK Pro", level 1 (top), 1-week free-trial intro offer | `com.grepawk.moviefone.pro_yearly` | GBK Pro Yearly | $47.99 | GBK Pro Yearly / "10x Studio budget and longer renders, billed yearly." | `pro` while active |
| GBK Pro Lifetime `price_1UUWjt4OymfcnKES8fWconiv` (plan=lifetime) | $99.00 one-time | Non-consumable | `com.grepawk.moviefone.lifetime` | GBK Pro Lifetime | $99.99 (no $99.00 point; nearest) | GBK Pro Lifetime / "Pro forever: 10x Studio budget, longer renders." | `pro` forever (unless refunded) |

`pro` = (docs/research/commercialization.md) 10× Studio composer-agent daily token budget (2M vs 200k) and 120 server renders/hour up
to 600 s (vs 30/h, 300 s). Family Sharing off. Prices in other storefronts: ASC auto-equalization from the USA base.

## iOS
- `Core/Store/PurchaseStore.swift` (StoreKit 2): products, `purchase(options: [.appAccountToken(uuid)])`, `Transaction.updates`
  listener started at launch, `Transaction.currentEntitlements`, Restore (`AppStore.sync()`).
- `appAccountToken`: account id when it is a UUID (guest random-username accounts and signed-in), else a random per-install UUID
  in the Keychain. No login required to buy.
- `Features/Store/PaywallView.swift`: sheet opened from Profile ("Get Pro"), the crown on the Create tab, and any Studio WebView link
  to `/pricing`, `grepawk.com/api/compose/checkout` or `*.stripe.com` (Stripe is blocked in-app per guideline 3.1.1).
- After each verified transaction the app POSTs the JWS (below); the transaction is finished only after the server answers.
  Until the endpoint exists, a 404 falls back to `MockIAPVerifier` (unlock from on-device StoreKit verification).

## Server endpoints needed (GBK Social; not implemented in server/)
1. `POST /api/iap/apple` — auth: optional Bearer (guest or signed-in session). Body
   `{ "signed_transaction": "<JWS from StoreKit 2>", "app_account_token": "<uuid>" }`.
   Verify the JWS with Apple's root CA chain (App Store Server Library), check `bundleId == com.grepawk.moviefone`, `environment`,
   productId ∈ the three above, and `appAccountToken` matches the caller's account UUID. Store
   `(account_id, original_transaction_id, product_id, expires_at, revoked_at, environment)`; idempotent on `transactionId`.
   Response `200 { "entitlements": ["pro"], "expires_at": <unix ms|null> }`; `400` invalid JWS; `409` token belongs to another account.
2. `POST /api/iap/apple/notifications` — App Store Server Notifications **v2** URL (set in ASC > App Information, production and
   sandbox). Body `{ "signedPayload": "<JWS>" }`; verify, then handle SUBSCRIBED, DID_RENEW, DID_FAIL_TO_RENEW, GRACE_PERIOD_EXPIRED,
   EXPIRED, REFUND, REVOKE, DID_CHANGE_RENEWAL_STATUS; map via `appAccountToken`/`originalTransactionId`. Reply 200.
3. Entitlement read: include `"pro": true|false` (and source `stripe|apple`) in `GET /api/me` (and for guests), and use it where
   limits are read (agent token budget, server render limits). Needs an In-App Purchase key (.p8) only if using the App Store
   Server API for lookups/refund history; JWS verification alone needs no key.

## App Store Connect
`ASC_ISSUER_ID=… python3 docs/asc/scripts/push_iap.py` (idempotent; `--dry-run` offline plan, `--verify` read-back,
`--no-screenshot`). Review screenshot: `docs/asc/screenshots/iap/paywall.png` (paywall snapshot from CI). Never submits for review;
the IAPs go to review with the next app version (select them on the version page).
