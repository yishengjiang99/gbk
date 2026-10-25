# Stripe catalog (GBK Composer Pro)

Live mode. Price IDs are not secret. Checkout and webhooks run on grepawk.com (finalcut `src/server/composeBilling.js`).

| Product | Price ID | Nickname | Amount | Interval | Metadata |
|---|---|---|---|---|---|
| prod_VVXeK2j4Dq3rOX (GBK Composer Pro) | price_1UUWYlAUW7JlNziKc0FBS1p7 | GBK Pro Monthly | $5.99 USD | month (7-day trial added by server) | product=compose plan=pro_monthly |
| prod_VVXeK2j4Dq3rOX | price_1UUWYlAUW7JlNziKCLQIzUrk | GBK Pro Yearly | $47.99 USD | year (7-day trial added by server) | product=compose plan=pro_yearly |
| prod_VVXeK2j4Dq3rOX | price_1UUWYlAUW7JlNziKNb8YZgId | GBK Pro Lifetime | $99.00 USD | one-time | product=compose plan=lifetime |

finalcut env: `COMPOSE_STRIPE_PRICE_PRO_MONTHLY`, `COMPOSE_STRIPE_PRICE_PRO_YEARLY`, `COMPOSE_STRIPE_PRICE_LIFETIME`.

Note: this product lives on Stripe account `acct_1StDNUAUW7JlNziK` (the photo-recipes account), not the account finalcut's `STRIPE_SECRET_KEY` uses, so checkout needs a compose-specific key + webhook secret on grepawk.com before it can go live.
