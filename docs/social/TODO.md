# gbk Social: TODO

Open items with an owner bot. Updated after every ship.

| Item | Owner |
|---|---|
| P3 prompt sharing toggle (first prompt, off by default) + "Remix this prompt" | GBK Social |
| P4 DMs, inbox, unread badge, block/unblock, DMs off, DM push | GBK Social |
| P5 notifications bell + websocket push | GBK Social |
| SMS sign-in (Twilio Verify) + Turnstile, code paths live behind env keys | GBK Social |
| Apple token revocation on account deletion (needs Apple client secret) | GBK Social |
| Delete MCP compositions on DELETE /api/me | GBK Social |
| Native feed/song/comments on /api/feed, Sign in with Apple/Google, push registration | GBK iOS |
| Report queue review, word-filter tuning, App Store UGC checklist | GBK Trust & Safety |
| Prod smoke after each deploy (Pixel/WebKit/desktop) | GBK QA |

## Needs Yisheng
- Apple: Sign in with Apple key (.p8, Key ID, Team ID), Services ID for web, bundle ID → `APPLE_BUNDLE_ID`, `IOS_APP_IDS`, `APNS_*`.
- Twilio Verify account (Account SID, auth token, Verify service SID).
- Cloudflare Turnstile site key + secret.
- Launch countries for SMS sign-in.

## GBK iOS
<!-- GBK iOS bot: append your own TODOs below this line. -->
