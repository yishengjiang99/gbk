# GBK Music Composer — App Store Connect answers

App: GBK Music Composer · Apple ID 6826906431 · SKU Music-composer-gbk · bundle ID com.grepawk.moviefone (team 83D36RPMUM).
Listing text: `metadata/en-US/`. Screenshots: 5 frames each for iPhone 6.9" (1320x2868, `iphone-69-*`) and 6.5" (1284x2778, `iphone-65-*`) in `screenshots/en-US/`, built from design mockups (feed, piece detail, remix, publish, explore; DM/Inbox left out until P4 ships). Regenerate with `python3 docs/asc/scripts/make_screenshots.py --config docs/asc/screenshots/config.json` (local copy of the playbook script with the LANCZOS fix, 6.5" size and upscaling).
Upload: `ASC_ISSUER_ID=... python3 docs/asc/scripts/push_listing.py` (`--dry-run`, `--verify`, `--no-screenshots`). It sets app info, category, content rights, age rating, version 1.0 text, review details and screenshots. It never submits for review. App Privacy answers must be entered by hand (no public API).

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
| Camera / Photos (Scan sheet music) | No: images are recognized on-device and never uploaded; only the resulting notes are saved in the song | — | — |
| Diagnostics, Location, Contacts, Health, Financial, Browsing, Purchases | No | — | — |

## Content rights

"Does your app contain, show, or access third-party content?" **Yes** — user-posted compositions. Users must own or have rights to what they post (see /terms). SoundFont samples are bundled under their licenses. The iOS app is open source (AGPL-3.0-or-later, `ios/LICENSE`); third-party components and licenses (homr models, omr-homr-ios, sf2player-swift, ONNX Runtime, GeneralUser GS) are listed in `ios/THIRD_PARTY_NOTICES.md` and linked in Profile › About.

## Age rating (questionnaire)

All "None" except: **Unrestricted Web Access: No** (the studio web view is limited to compose.grepawk.com), **User-Generated Content: Yes** (feed and comments, with report, block and moderation), **Messaging and Chat: No** (switch to Yes when DMs ship). Expected rating: 13+ (Apple may set 12+/13+ for UGC). Made for Kids: No.

## Review notes (paste into App Review Information)

```
GBK Music Composer — App Review Notes

WHAT THE APP DOES (purpose and audience)
GBK Music Composer lets anyone create original music by describing it in plain words. Type "write a Bach-style fugue in D minor" or "a gentle piano waltz" and the app composes a full score you can play, edit note by note in the studio (piano roll and sheet view), and share. It also scans printed sheet music with the camera and turns it into editable notes. It is for music students, hobbyists, and educators who have musical ideas but little notation training. The problem it solves: conventional notation software requires years of training before you can write down the music you hear in your head.

NO LOGIN IS REQUIRED
The app is fully usable with no account. An optional sign-in exists only for publishing your own pieces to the feed and for ratings and comments. No demo account is needed for review.

HOW TO REVIEW THE MAIN FEATURES
1. Launch the app. It opens on the Feed: tap any piece to hear it play with sampled instruments (SoundFonts).
2. Tap Create to open the Studio. Type a prompt, for example "Write a gentle piano waltz in G major", and tap Send. The composition appears in the editor within a few seconds (internet required). Press play to hear it.
3. Keep chatting to revise it ("make it faster", "add a walking bass line"), or edit notes directly in the piano roll.
4. Sheet-music scan: in the Studio, tap the scan/camera button and point the camera at printed sheet music. Recognition runs on the device and the notes appear in the editor.
5. Paid content: the paywall appears when a free-plan limit is reached, and from the Pro option in the app menu. It offers GBK Pro Monthly ($5.99) and GBK Pro Yearly ($47.99), each with a 7-day free trial, and GBK Pro Lifetime ($99.99, one-time). Free plan: 10 revisions per piece, pieces up to 64 bars. Pro raises those limits (100 revisions, 256 bars, longer renders). All purchases are Apple in-app purchases and work in the sandbox.

EXTERNAL SERVICES
- Our own backend server (compose.grepawk.com): hosts the shared feed and optional accounts, and runs the composition agent. To turn a text prompt into music, the server sends the prompt to a third-party large language model API; the model is only ever contacted from our server, never from the app directly.
- Apple services: In-App Purchase, and APNs for push notifications.
- No advertising, no third-party analytics, and no tracking SDKs.
Sheet-music recognition and SoundFont playback run entirely on the device. Camera images are never uploaded.

REGIONAL DIFFERENCES
None. The app functions consistently in all regions; only App Store pricing is localized.

REGULATED INDUSTRY / THIRD-PARTY MATERIAL
Not applicable: the app is not in a regulated industry. All bundled SoundFonts are openly licensed for redistribution, and compositions are generated by the app or created by users. The app itself is open source (AGPL v3).
```

Sign-in fields in ASC: none. Demo account not required (the app works without an account; sign-in is optional).
