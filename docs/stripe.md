# Stripe catalog (GBK Composer Pro)

Live mode. Price IDs are not secret. Checkout and webhooks run on grepawk.com (finalcut `src/server/composeBilling.js`).

| Product | Price ID | Nickname | Amount | Interval | Metadata |
|---|---|---|---|---|---|
| prod_VVXpcLHC6Ahg5t (GBK Composer Pro) | price_1UUWjt4OymfcnKESqqY2SpC4 | GBK Pro Monthly | $5.99 USD | month (7-day trial added by server) | product=compose plan=pro_monthly |
| prod_VVXpcLHC6Ahg5t | price_1UUWjt4OymfcnKESKn99TpqY | GBK Pro Yearly | $47.99 USD | year (7-day trial added by server) | product=compose plan=pro_yearly |
| prod_VVXpcLHC6Ahg5t | price_1UVND54OymfcnKESIgTy5Oc2 | GBK Pro Lifetime | $99.99 USD | one-time | product=compose plan=lifetime (replaces $99.00 price_1UUWjt4OymfcnKES8fWconiv) |

finalcut env: `COMPOSE_STRIPE_PRICE_PRO_MONTHLY`, `COMPOSE_STRIPE_PRICE_PRO_YEARLY`, `COMPOSE_STRIPE_PRICE_LIFETIME`.

Product is on acct_1StD764OymfcnKES (the account behind FinalCut's `STRIPE_SECRET_KEY`), statement descriptor `GBK COMPOSER`, product metadata product=compose app=gbk site=https://compose.grepawk.com. The original product prod_VVXeK2j4Dq3rOX on acct_1StDNUAUW7JlNziK (photo-recipes account) is unused; left in place to archive.
