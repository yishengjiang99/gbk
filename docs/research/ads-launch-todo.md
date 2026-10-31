# GBK Composer: ads launch to-do (X Ads + Reddit Ads)

An ordered checklist for Yisheng to run the first paid test himself, adapted from the AI Music Radar one
(earsheet `docs/research/ads-launch-todo.md`). It depends on:
- finalcut #118 (product entitlements, music) merged and deployed, then the finalcut compose PR stacked on it.
- this gbk PR (`/pricing`, `/pricing/thanks`, `/plans`, pixels, waitlist) merged and deployed.

Audiences and creatives come from `docs/research/commercialization.md` §5.

**Budget numbers here are assumptions, not data.** Ad-platform menu names change; the linked help pages (checked
for the music launch on 2026-10-22) win if the UI differs.

Off switch for everything: `COMPOSE_ADS_ENABLED=0` in `/etc/gbk-composer.env` (pixels, restart gbk-composer) and
`ADS_TRACKING_ENABLED=0` in the finalcut `.env` (server Conversions API for music **and** compose, restart finalcut).

---

## 0. Decide what you sell (before any ad money)
- [ ] Pro limits are **not enforced yet** (commercialization.md §4). Until they are, keep `COMPOSE_CHECKOUT_ENABLED=0`: `/pricing` shows plans + waitlist. Run the first ads to `/chatgpt` (free product) and measure waitlist sign-ups. **Recommended.**
- [ ] Add paid-plan terms (billing, renewal, cancellation, your refund policy) to `/terms`; today it says "free, experimental".
- [ ] Check the ChatGPT listing status. While it says "coming soon", ad copy must point to Studio / the MCP URL, not "Install in ChatGPT".

## 1. Stripe (only when you turn checkout on)
- [ ] Stripe dashboard (live) → Product catalog → **"GBK Composer Pro"**: recurring **$5.99/month** and **$47.99/year** (created: prod_VVXeK2j4Dq3rOX); one-time **$99.99** (lifetime, price_1UVND54OymfcnKESIgTy5Oc2). Don't add a trial on the price; the server adds 7 days.
- [ ] Webhooks: the existing `https://grepawk.com/api/stripe-webhook` endpoint already covers compose (needs `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, same as music).
- [ ] finalcut `.env` (`/home/finalcut/apps/pages/finalcut/.env`), then `systemctl restart finalcut`:
  ```
  COMPOSE_STRIPE_PRICE_PRO_MONTHLY=price_…
  COMPOSE_STRIPE_PRICE_PRO_YEARLY=price_…
  COMPOSE_STRIPE_PRICE_LIFETIME=price_…
  COMPOSE_SITE_URL=https://compose.grepawk.com
  COMPOSE_ENTITLEMENT_TOKEN=<long random string; the same value goes into the gbk env when the gate ships>
  ```
- [ ] `/etc/gbk-composer.env`: `COMPOSE_CHECKOUT_ENABLED=1`, restart gbk-composer. Smoke test: sign in, open `/pricing`, **Start free trial** (yearly) → Stripe Checkout prefilled with your GBK email; **Cancel** → `/pricing?checkout=cancel`. One real lifetime purchase with your card, then refund it. `/pricing/thanks` shows.

## 2. X Ads account, pixel and events
- [ ] https://ads.x.com as the brand handle; time zone America/Los_Angeles (permanent), USD; add a card (Tools menu appears after). Help: https://business.x.com/en/help/account-setup/ads-account-setup
- [ ] Tools → Events Manager → Add event source → **X Pixel** (1st-party cookies on). Copy the id in `twq('config','XXXXX')`. (You can reuse the music pixel only if both sites are on the same ad account; a separate pixel keeps reports clean.)
- [ ] Add events, "Define event with code": **Purchase** ("Compose Purchase"), **Start trial** ("Compose Start Trial"). Copy each `tw-XXXXX-YYYYY`.
- [ ] `/etc/gbk-composer.env`, restart gbk-composer:
  ```
  COMPOSE_ADS_ENABLED=1
  COMPOSE_X_PIXEL_ID=XXXXX
  COMPOSE_X_EVENT_ID_PURCHASE=tw-XXXXX-…
  COMPOSE_X_EVENT_ID_START_TRIAL=tw-XXXXX-…
  ```
- [ ] Server-side (needs X Ads API access, same app/creds as music): finalcut `.env` `COMPOSE_X_PIXEL_ID`, `COMPOSE_X_EVENT_ID_PURCHASE`, `COMPOSE_X_EVENT_ID_START_TRIAL` (the `X_ADS_*` creds are shared). Docs: https://docs.x.com/x-ads-api/measurement/web-conversions

## 3. Reddit Ads account, pixel and CAPI
- [ ] https://ads.reddit.com, America/Los_Angeles, USD, card on file.
- [ ] Events Manager → Reddit Pixel (manual/code) → copy the id from `rdt('init','…')`. Don't set up Purchase/StartTrial in the no-code Event Setup Tool (the thanks page fires them with a dedupe id; doing both double-counts).
- [ ] `/etc/gbk-composer.env`: `COMPOSE_REDDIT_PIXEL_ID=…`; finalcut `.env`: `COMPOSE_REDDIT_PIXEL_ID=…` (`REDDIT_CAPI_TOKEN` is shared with music). Restart both.

### Server-side conversions from gbk (#130)
gbk itself can now send the X and Reddit Conversions API events from the billing hop (`server/src/ads/conversions.ts`), so
finalcut only has to forward `event_id`, `twclid`, `rdt_cid` and the buyer's email (hashed in gbk) on `purchase` / `trial_start`.
In `/etc/gbk-composer.env`: `X_ADS_CONSUMER_KEY`, `X_ADS_CONSUMER_SECRET`, `X_ADS_ACCESS_TOKEN`, `X_ADS_ACCESS_TOKEN_SECRET`,
`REDDIT_CAPI_TOKEN` (plus the pixel/event ids above). Turn on the server-side send in ONE service only (gbk or finalcut);
the shared conversion id dedupes browser + server, but two servers would still double-send. Boot log line `ads_capi`
shows `{x, reddit}` true/false (no ids or secrets).

## 4. Verify (before launch)
- [ ] Open `https://compose.grepawk.com/pricing?utm_source=test&twclid=test123&rdt_cid=test456`, ad blockers and GPC off: X Pixel Helper shows the pixel; Reddit Pixel Helper shows `PageVisit`.
- [ ] With checkout on: start a trial; on `/pricing/thanks` X "Start trial" and Reddit Custom "StartTrial" fire. Stripe session metadata has `product=compose`, `event_id`, `utm_source=test`, `twclid`, `rdt_cid`. finalcut logs show no `[ads] … CAPI` warnings. Cancel the trial.
- [ ] Events Manager on both shows events received within ~1 h, browser + server not doubled (shared `conversion_id`).
- [ ] With GPC on (Brave), no pixels load. With `COMPOSE_ADS_ENABLED=0`, no pixel scripts in the page source.

## 5. Campaigns
- [ ] **X**: objective Website traffic (landing-page views). Destination `https://compose.grepawk.com/chatgpt?utm_source=x&utm_medium=paid&utm_campaign=launch1&utm_content=<creative>`. Switch to Website conversions after ~20 conversions/week (assumption).
- [ ] **Reddit**: objective Traffic first (no Lead event on compose yet), then Conversions once trials exist. Destination with `utm_source=reddit`.

## 6. Audiences
- [ ] X: US, English; interests Music production, Music, Game development, AI; follower look-alikes @OpenAI, @ChatGPTapp, @suno_ai_, @hooktheory, @AbletonLive; keywords "MIDI", "music theory", "chord progression", "AI music"; expanded targeting off.
- [ ] Reddit: r/musictheory, r/composer, r/WeAreTheMusicMakers, r/edmproduction, r/gamedev, r/IndieDev, r/ChatGPT, r/LocalLLaMA, r/midi.

## 7. Creatives (3 per platform)
- [ ] X: #1 "Describe it. Get MIDI." (8 s video), #2 "Edit one bar, not the whole song", #3 "Your agent can compose now".
- [ ] Reddit: #5 founder text post (fugue demo), #1 video, #4 game-dev cues.
- [ ] #6 (price) only after checkout is on. Never promote Pro inside ChatGPT or in the plugin.

## 8. Budget (ALL ASSUMPTIONS)
- [ ] ~$15/day per platform for 14 days (~$210 each), campaign daily cap + $210 total cap per platform. Auto-bid.

## 9. Launch and watch
- [ ] Launch on a weekday morning PT. Note starting counts: funnel (`node deploy/funnel.mjs` or `/api/admin/funnel`), waitlist rows (`pro-waitlist.sqlite`), Stripe.
- [ ] Day 1: ads approved and spending; `page_view_chatgpt` rising; no Events Manager errors.
- [ ] Day 3: pause creatives under 0.5% CTR after 2,000 impressions (assumption); check `create` events from `web`/`studio` per ad dollar.
- [ ] Day 7: cost per first composition and per waitlist sign-up; if CAC per paid Pro > $40 with no trend down, stop (assumption).
- [ ] Stop everything: pause campaigns, `COMPOSE_ADS_ENABLED=0` (gbk) and `ADS_TRACKING_ENABLED=0` (finalcut), restart both.
