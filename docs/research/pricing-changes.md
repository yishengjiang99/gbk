# Pricing page changes (sequential tests)

One change at a time, shipped to everyone (no cohorts). Each change runs at
least a week before the next one. For every change, compare the
**paywall_view -> checkout_start** conversion rate week over week against the
pre-change week, and note the result here before making the next change.

The off switches stay as they are: `COMPOSE_CHECKOUT_ENABLED` (Buy buttons vs
waitlist) and `COMPOSE_ADS_ENABLED` (ad pixels). Presentation changes never
touch prices, Stripe price ids, or checkout behavior.

## 2026-10-26 — Yearly default, value-led copy, sticky CTA (issue #121)

Baseline before this change: /pricing listed the Free card first and monthly
before yearly; yearly was shown as "$47.99/year" with no default highlighted;
there was no sticky CTA.

Changed:

- Yearly is now the preselected default plan: first paid card, featured
  styling with a "Best value" badge, and the sticky CTA also defaults to it.
- Yearly is presented as "$4/month billed yearly" (the real $47.99/year,
  divided by 12) with "save 33%" vs monthly.
- Plan order is now yearly, monthly, lifetime, then the Free card last.
- Lead copy leads with the value users feel: 10x the AI composer budget,
  longer renders (up to 10 minutes each), and the 7-day free trial. The FAQ
  "What does Pro add?" answer leads the same way; the ChatGPT purchase
  explanation in the FAQ is unchanged.
- Added a sticky CTA bar at the bottom of /pricing (yearly trial when
  checkout is on, waitlist link while it is off).

Not changed: every price ($5.99/month, $47.99/year, $99 lifetime), all Stripe
price ids, checkout flow, and the two off switches above.

Metric to compare: paywall_view -> checkout_start, the week after 2026-10-26
vs the week before.
