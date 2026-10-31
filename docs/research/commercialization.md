# compose.grepawk.com: commercialization and ads research (2026-10-25)

Scope: turn GBK Composer (this repo, prod https://compose.grepawk.com, MCP at `/mcp`) into a paid product, reusing the
process and the Stripe code from AI Music Radar (earsheet #93/#95, finalcut #118). Everything below was checked on
2026-10-25 (PT) with curl against prod (`--resolve compose.grepawk.com:443:64.23.239.208`) and by reading the code.
**Every budget or threshold figure in this doc is an assumption, not data.** Prices of competitors are quoted from
their own pages with the URL.

## 1. Where it lives
- Web + MCP server: `gbk-composer.service` on 64.23.239.208, env `/etc/gbk-composer.env`, data `/var/lib/gbk-composer`.
- Stripe/checkout: the finalcut server on grepawk.com (`finalcut.service`, env `/home/finalcut/apps/pages/finalcut/.env`).
  finalcut #118 (open, not merged) adds product-scoped entitlements; the companion finalcut PR adds `compose` to it.
- Launch work by the "GBK Launch" agent: `docs/launch/*`, `scripts/launch/*`, `server/src/mcp/*`, gallery, plugin
  submission. It has no open PRs today; this work stays out of those files (two one-line edits in `pages.ts`, see §7).

## 2. Product (consumer walkthrough of the live site)
GBK Composer is a ChatGPT plugin (also any MCP client: Codex, Claude, Cursor, VS Code, Grok Bot, xAI API) that
writes **real, editable MIDI** from a prompt ("Compose a 16-bar Baroque fugue in D minor for organ"), then edits it
passage by passage (add walking bass, transpose, humanize, CC11 crescendo in bars 9–16) as saved revisions, plays it
in an in-chat piano-roll player with a bundled GeneralUser GS SoundFont, and renders WAV in the browser (or on the
server for clients without a browser). Five styles (baroque incl. a fugue generator, classical, pop, jazz, ambient).
GBK Studio (`/studio`) is the full web DAW-style editor with its own composer agent. Free, no account needed;
optional Google/GitHub sign-in.

What a visitor sees, page by page:
| URL | What's there |
| --- | --- |
| `/` and `/explore` | SPA. HTML title was "SF2 Explorer", no meta description, empty `<div id="root">` for crawlers. |
| `/chatgpt` | The real landing: pitch, 3 starter prompts, 3 featured demos, "Use with other AI apps" (MCP URL + per-client config), limits. CTA says **"ChatGPT listing: coming soon"**. |
| `/chatgpt/gallery` | 6 engine-built demos with piano rolls and downloads (284 KB page). |
| `/privacy`, `/terms`, `/support` | Server-rendered, good SEO tags. Support is GitHub issues only. |
| `/mcp` | `initialize` works without auth (`serverInfo gbk-composer 1.0.0`); OAuth metadata at `/.well-known/oauth-protected-resource`, scopes `gbk:compositions.*`, `gbk:renders.create`, `gbk:artifacts.read`, `gbk:shares.publish`. |

Confusing or broken spots:
1. **The ChatGPT listing isn't live.** The main CTA is "coming soon", so a ChatGPT user from an ad has no one-click install. Biggest blocker for ads.
2. **Home page identity.** `/` and `/explore` were titled "SF2 Explorer" (an internal tool name) with no description; the pitch only exists at `/chatgpt`. (This PR fixes the `index.html` head: title, description, OG/Twitter, JSON-LD.)
3. **Soft 404s.** Any unknown path (e.g. `/definitely-not-a-page`, and `/pricing` before this PR) returns the SPA with HTTP 200.
4. **Inconsistent share cards.** The SPA uses the 1920×1080 cover (`summary_large_image`); `/chatgpt` uses `icon.png` with a small `summary` card. Ads and organic shares of `/chatgpt` get the small card.
5. **First browser render downloads a ~32 MB SoundFont** (support page says so). On phones from an ad this is a slow first impression.
6. **"Daily limit reached"** is mentioned on /support, but the limits (6 server renders/h guest, 30/h signed in, up to 180/300 s) are only on `/chatgpt#other-ai-apps`. There is no explanation of what more you could get.
7. No pricing page, no way to pay, nothing gated by payment today.

## 3. Does a Stripe paywall fit a ChatGPT plugin?
Only partly, and the doc has to be honest about it. OpenAI's plugin guidelines
(https://developers.openai.com/plugins/app-guidelines, "Commerce and monetization"):
- Plugins "may conduct commerce only for physical goods. Selling digital products or services—including subscriptions, digital content, tokens, or credits—is not allowed, whether offered directly or indirectly (for example, through freemium upsells)."
- "Users may sign in to an existing paid account and access features already included in their subscription. Plugins must not display subscription plans, initiate new subscriptions, or promote upgrades."
- A plugin may "explain that a certain feature is not available with the user's current plan" and "link to an informational page describing available plans", but may not link to checkout or a page that "explicitly initiates" a purchase.
- "If the same feature … is also available through your external website … you must not provide a worse version through your plugin" and no ChatGPT-specific pricing.

What this means for GBK:
- **ChatGPT is a free acquisition channel, not a checkout.** Revenue has to come from the website (`/pricing`) and GBK Studio.
- The MCP server **may** read an entitlement for a signed-in (OAuth) user and apply higher limits. It **may not** say "upgrade for $5.99", show plans, or link to `/pricing`. On a quota error it may say "this exceeds the free plan's limit" and link to an **informational** page; this PR adds `/plans` for exactly that (no buttons, no checkout links, test-enforced).
- Costs: inside ChatGPT the LLM is ChatGPT's, so GBK's marginal cost there is server rendering CPU. The real cost centre is the **composer agent inside GBK Studio** (GBK pays the model tokens; config has `AGENT_DAILY_TOKEN_BUDGET` 2,000,000 and `AGENT_NEW_ACCOUNT_DAILY_TOKEN_BUDGET` 200,000 per user/day, `AGENT_DAILY_COST_BUDGET_USD` 5). So Pro should mostly buy **Studio AI budget**, plus server-render headroom for no-browser clients (Codex etc.).
- Plan parity rule: whatever Pro unlocks must unlock it in ChatGPT too (for a signed-in Pro user), never be better on the web.

## 4. Market

### Audience
1. **Hobbyist composers and music-theory learners** who already use ChatGPT and want MIDI they can open in a DAW or notation app (r/musictheory, r/composer, r/WeAreTheMusicMakers, r/edmproduction for MIDI ideas).
2. **Game/indie devs and content creators** who need short royalty-free cues as editable MIDI, not a locked audio file.
3. **Developers building with MCP** (Claude/Cursor/Codex users) — a free "music tool for your agent"; good for word of mouth, weak payers.
Primary for paid ads: #1 and #2, US/UK/CA/AU, English.

### Competitors (real prices, checked 2026-10-25)
| Product | What you get | Price | Source |
| --- | --- | --- | --- |
| Suno | Text-to-song audio (not editable MIDI) | Free 50 credits/day; Pro $8/mo, Premier $24/mo (billed yearly) | https://suno.com/pricing |
| AIVA | AI composition, MP3 + MIDI downloads | Free €0; Standard €11/mo, Pro €33/mo (billed annually) | https://www.aiva.ai/pricing |
| Hookpad (Hooktheory) | Chord/melody sketchpad, MIDI export | Standard $7.99/mo or $199 lifetime; Aria AI add-on +$14.99/mo | https://www.hooktheory.com/hookpad/pricing |
| SOUNDRAW | AI royalty-free background music | Creator $16.99/mo ($11.04/mo yearly); Artist plans $29.99–$50/mo | https://soundraw.io/pricing |
(udio.com/pricing loads client-side and gave no readable prices to curl; not quoted.)

Positioning: GBK is the only one of these that **lives inside ChatGPT/MCP clients** and outputs **revisable MIDI with per-passage edits**. Suno is audio-first; AIVA/Hookpad are separate apps. The price anchor for "AI that writes MIDI" is roughly $8–$15/month.

### Recommended pricing
- **Free** (unchanged, the default for everyone, including all ChatGPT use within today's limits).
- **Pro $6/month or $48/year**, 7-day free trial; **Pro lifetime $99.99** one-time.
- Pro = signed-in account with: 10× the Studio composer-agent daily budget (2M vs 200k tokens, i.e. today's `AGENT_DAILY_TOKEN_BUDGET` vs new-account budget), 120 server renders/hour up to 600 s (vs 30/h, 300 s).
- Why this price: under Suno Pro ($8) and Hookpad ($7.99), well under AIVA Standard (€11), because GBK's paid value is narrower (limits, not features) and the main channel (ChatGPT) can't upsell. Lifetime at ~2 years of yearly mirrors Hookpad's lifetime option; **risk**: lifetime buyers keep consuming Studio tokens forever, so cap lifetime sales (e.g. first 200, assumption) or drop it if token cost per Pro user exceeds ~$2/month (assumption).
- Honest expectation: conversion will be low while the plugin can't mention Pro. Treat paid ads as a test of whether **web/Studio** users pay.

### How the MCP and Studio would gate by entitlement (proposal, not implemented)
1. finalcut (companion PR, stacked on #118) stores `product_entitlements(product='compose')` from the Stripe webhook, and exposes `GET https://grepawk.com/api/compose/entitlement?email=…` with `Authorization: Bearer $COMPOSE_ENTITLEMENT_TOKEN` → `{ pro: true|false }` (404 until the token is set).
2. GBK server: a small `ProStatus` helper (account email → cached boolean, 10 min TTL, fail-closed to Free on errors) used where limits are read today: `cfg.serverRender.accountPerHour/accountMaxSeconds` in `server/src/mcp/browser-render.ts` / `server-render.ts`, and the per-user token budget in the Studio agent (`server/src/agent`). Only signed-in accounts with an email can be Pro; guests and ChatGPT-without-OAuth stay Free.
3. Quota error text inside the plugin: "This is over the free plan's limit (30 server renders per hour). Plans: https://compose.grepawk.com/plans" — no prices, no "upgrade" verb, no checkout link.
4. Not implemented here because steps 2–3 change MCP server internals owned by GBK Launch. It is ~60 lines + tests; do it as one PR after #118 merges, coordinated with GBK Launch.
5. Until it ships, `COMPOSE_CHECKOUT_ENABLED` stays `0`: `/pricing` shows the plans and a **waitlist**, not Buy buttons, so nobody pays for limits that aren't enforced.

Email mismatch risk: Stripe email ≠ GBK sign-in email. Mitigation in this PR: when a signed-in user presses Buy, checkout is prefilled with the GBK account email.

## 5. Ads

### Targeting
- **X**: US, English. Interests: Music production, Music, Video games/game development, Technology (AI). Follower look-alikes: @OpenAI, @ChatGPTapp, @suno_ai_, @hooktheory, @AbletonLive. Keywords: "MIDI", "music theory", "chord progression", "ChatGPT plugin", "AI music". Optimized/expanded targeting off for the first test.
- **Reddit**: communities r/musictheory, r/composer, r/WeAreTheMusicMakers, r/edmproduction, r/gamedev, r/IndieDev, r/ChatGPT, r/LocalLLaMA (MCP angle), r/midi. Interest: Music, Technology.
- Landing: `/chatgpt` (the product) for traffic tests; `/pricing` only once checkout is on.

### Creatives (6)
1. **"Describe it. Get MIDI."** Video: 8 s screen capture of a ChatGPT prompt → piano roll → play. Copy: "Type 'a 16-bar Baroque fugue in D minor' and get real MIDI you can edit, play and drag into your DAW. Free in ChatGPT." CTA: Try it free.
2. **"Edit one bar, not the whole song."** Carousel of revisions (add walking bass → transpose → CC11 crescendo). Copy: "AI music you can actually revise. Change bars 9–16, keep the rest."
3. **"Your agent can compose now."** (X/r/LocalLLaMA, devs) Copy: "GBK Composer is a free MCP server: paste compose.grepawk.com/mcp into Claude, Cursor or Codex and ask for a jazz cue." Code-block image.
4. **"Royalty-free cues, as MIDI."** (game devs) Copy: "Need a 60-second orchestral cue in C minor? Get the MIDI and WAV; you keep the rights (per the terms)."
5. **Founder text post** (Reddit native): "I built a ChatGPT plugin that writes editable MIDI (Bach-style fugues included). Roast the counterpoint." Link to the fugue demo in `/chatgpt/gallery`.
6. **Demo audio** (after Pro is live): 15 s of the Orchestral Cue with piano-roll visual; copy "Made in a chat. Pro from $6/month." — run only once checkout is on, and never inside ChatGPT.
Don't use price-comparison copy against Suno/AIVA without rechecking their pages the same day.

### KPIs (targets are assumptions)
- CTR ≥ 0.8% (X), ≥ 0.5% (Reddit); landing → "Open GBK Studio" or MCP-URL copy ≥ 15%.
- Cost per first composition (funnel `create` event, source `web`/`studio`) ≤ $3.
- Waitlist sign-up rate on `/pricing` ≥ 5% of visitors; later trial start ≥ 2%, trial → paid ≥ 30%.
- Stop rule: CAC > $40 per paid Pro after 2 weeks with no downward trend.

### Test budget (ASSUMPTION)
$15/day per platform for 14 days (~$210 each), split across 3 creatives, hard campaign caps.

## 6. Blockers before ads (top first)
1. **ChatGPT listing not live** ("coming soon"). Ads to ChatGPT users have no install path; run traffic to Studio + MCP URL, or wait for approval.
2. **Pro isn't enforced** (gate in §4 not built), so checkout must stay off; first ads can only measure interest (waitlist).
3. **finalcut #118 must merge and deploy first**, then the compose PR on top of it; then Stripe prices + env.
4. Home page/SEO: soft 404s; `/chatgpt` share card is the small icon (fix to the 1920×1080 cover); 32 MB first SoundFont download on mobile.
5. Ad accounts, pixels, X Ads API approval for the server-side Conversions API (see `ads-launch-todo.md`).
6. Support is public GitHub issues only; paying customers need a private email (refunds, billing).
7. **Terms say the service is "free, experimental"**: add paid-plan terms (billing, renewal, cancellation, refund policy you choose) before turning checkout on.

## 7. What shipped with this doc
- gbk PR: `/pricing` (plans, Free vs Pro table, FAQ, `SoftwareApplication`+`Offer` and `FAQPage` JSON-LD, OG/Twitter), Buy forms → `https://grepawk.com/api/compose/checkout` (behind `COMPOSE_CHECKOUT_ENABLED`), waitlist (`POST /api/pricing/waitlist`, `pro-waitlist.sqlite`), `/pricing/thanks` (noindex, pixel conversion with dedupe id), `/plans` (informational, for the plugin), `/privacy/payments-and-ads`, X + Reddit pixels with one off switch `COMPOSE_ADS_ENABLED=0` and GPC/DNT respect, sitemap entries, `index.html` SEO head. Edits outside new files: `app.ts` (register), `pages.ts` (sitemap list only), `index.html`, `deploy/compose.env.example`.
- finalcut PR (stacked on #118): `compose` product with `pro_monthly`/`pro_yearly`/`lifetime`, shared product webhook handler, `COMPOSE_*` pixel prefix for X/Reddit CAPI, entitlement lookup endpoint. FinalCut and music paths unchanged (full suite passes).
