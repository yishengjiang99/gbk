# GBK Music Composer — App Store Connect answers

App: GBK Music Composer · Apple ID 6826906431 · SKU Music-composer-gbk · bundle ID com.grepawk.gbk (team 83D36RPMUM).
Listing text: `metadata/en-US/`. Screenshots (6.9", 1320x2868, 2 frames from design mockups; DM/Inbox frames dropped until P4 ships): `screenshots/en-US/`, regenerate with
`python3 app-store-playbook/make_screenshots.py --config docs/asc/screenshots/config.json` (fix `Image.Lanczos` → `Image.LANCZOS` in the script first).

## App Privacy (nutrition label)

Tracking: **No**. No data is used for tracking or shared with data brokers. No third-party ad or analytics SDKs.

| Data type | Collected | Linked to user | Purpose |
|---|---|---|---|
| Contact Info › Email Address | Yes (Sign in with Apple / Google; may be a private relay address) | Yes | App Functionality |
| Contact Info › Name | Yes (display name) | Yes | App Functionality |
| User Content › Audio Data / Other User Content (compositions, prompts, MIDI/WAV) | Yes | Yes | App Functionality |
| User Content › Other User Content (comments, ratings, direct messages) | Yes | Yes | App Functionality |
| Identifiers › User ID (account id) | Yes | Yes | App Functionality |
| Identifiers › Device ID (APNs push token) | Yes | Yes | App Functionality (push notifications) |
| Diagnostics, Location, Contacts, Health, Financial, Browsing, Purchases | No | — | — |

## Content rights

"Does your app contain, show, or access third-party content?" **Yes** — user-posted compositions. Users must own or have rights to what they post (see /terms). SoundFont samples are bundled under their licenses.

## Age rating (questionnaire)

All "None" except: **Unrestricted Web Access: No** (the studio web view is limited to compose.grepawk.com), **User-Generated Content: Yes** (feed and comments, with report, block and moderation), **Messaging and Chat: No** (switch to Yes when DMs ship). Expected rating: 13+ (Apple may set 12+/13+ for UGC). Made for Kids: No.

## Review notes (paste into App Review Information)

```
GBK Music Composer is a feed of short music pieces that users can play, rate, comment on and remix in a studio (compose.grepawk.com in a web view).

Sign-in: Browsing and playback need no account. To test signed-in features (ratings, comments, report/block) use the review account:
  Username: openai-reviewer
  Password: (entered in the "Sign-in information" fields of App Review Information)
Reviewer sign-in page: https://compose.grepawk.com/signin/reviewer (form posts to /api/auth/reviewer). It is the same account used for our ChatGPT app review and has normal daily limits.

UGC safeguards (Guideline 1.2): every piece and comment has Report, and users can be blocked; reports are reviewed within 24 h and offending content is removed. Terms: https://compose.grepawk.com/terms.
Push notifications are only used for replies and forks and are opt-in.
Account deletion: Profile › Delete account (DELETE /api/me), also via Support (https://compose.grepawk.com/support).
```

Sign-in fields in ASC: username `openai-reviewer`; password is held by Yisheng (never commit it).
