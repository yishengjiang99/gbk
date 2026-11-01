# Live Jam: integration map

Two to four players in a private room, full-mesh WebRTC data channels, every client synthesizes every
player locally. The server owns rooms, membership, signaling and TURN credentials. It never touches audio.

Server/deploy landed first (PR #174). The web client is described under "Web client" below. iOS comes later.

## Where it plugs in

| Area | Existing code | Jam change |
|---|---|---|
| HTTP app | `server/src/app.ts` | builds `JamRooms` + `JamSignaling`, registers `routes/jam.ts` |
| Upgrade routing | `app.ts` `server.on("upgrade")` | one router: `/api/agent/ws` -> `AgentHub`, `/api/jam/ws` -> `JamSignaling`, everything else destroyed |
| Auth | `currentSession` / `guardWrite` (`routes/agent.ts`) | reused as is: cookie + Origin + CSRF on web, `Authorization: Bearer` on native, guests (`gu-*`) allowed with lower create quota |
| Rate limits | `security/rate-limit.ts` | per-account create/join/ICE limits, per-IP join and upgrade limits, per-socket frame limit |
| Persistence | SQLite per store under `COMPOSER_DATA_DIR` | `jam.sqlite`: rooms, hashed invites, memberships. Written only on create/join/leave/kick/host/end |
| Config | `server/src/config.ts` | `cfg.jam` (`JAM_*`), validated at boot |
| Shared protocol | none before | `shared/jam/signaling.ts`: zod frame schemas, codec, HTTP bodies. Included by root and server tsconfig |
| nginx | `deploy/nginx.conf`, `deploy/nginx.docker.conf` | `location = /api/jam/ws` with upgrade headers and no `proxy_next_upstream`. `/jam/*` falls through to the SPA |
| Agent bridge | `server/src/bridge/*` | untouched. Jam uses a separate `WebSocketServer`, no run slots, no LLM |

Next PRs: `src/jam/` + `src/components/jam/` (web client, timed worklet queue on `sf2-processor-core.ts`,
`synth-ingress.ts` reuse, `midi-input.ts` timestamp fix), then `ios/GBKComposer/Features/Jam/`.

## Server contract (v1)

All room routes take the caller's `participantId` and check it belongs to the session's account.
Unknown room, not a member and wrong account all return the same 404.

| Route | Who | Notes |
|---|---|---|
| `POST /api/jam/rooms` | signed in | returns `{participantId, snapshot, invite:{token, code, expiresAt, codeExpiresAt}}` |
| `POST /api/jam/rooms/:id/join` | invite holder | body `{invite, name?, participantId?}`. `participantId` resumes your own device without using a slot |
| `POST /api/jam/join` | invite holder | same, for a human code with no room id |
| `GET /api/jam/rooms/:id?participantId=` | member | snapshot |
| `POST /api/jam/rooms/:id/ws-ticket` | member | single-use, 30 s ticket |
| `POST /api/jam/rooms/:id/ice-credentials` | member | TURN REST credentials, 503 `TURN_UNCONFIGURED` if no TURN |
| `POST /api/jam/rooms/:id/invite` | host | rotate: old link and code stop working |
| `POST /api/jam/rooms/:id/invite/revoke` | host | |
| `POST /api/jam/rooms/:id/lock`, `/unlock` | host | |
| `POST /api/jam/rooms/:id/kick` `{participantId, target}` | host | target socket gets `kicked`, others `peer-left` |
| `POST /api/jam/rooms/:id/host` `{participantId, target}` | host | atomic swap |
| `POST /api/jam/rooms/:id/leave` | member | last one out ends the room; host leaving picks a successor |
| `POST /api/jam/rooms/:id/end` | host | all sockets get `ended` |

Errors use the app's `{code, message}` shape: `ROOM_FULL` (409), `ROOM_LOCKED`, `NOT_HOST` (403),
`INVITE_INVALID`, `NOT_FOUND` (404), `ROOM_LIMIT`, `RATE_LIMITED` (429).

### Invites

Link token: 24 random bytes. Human code: 8 characters, no 0/O/1/I/L, case and dash insensitive, 15 minute
default life. Both stored as SHA-256 only. Joins are rate limited per account and per IP.

### Participant limit

`join` runs inside a `BEGIN IMMEDIATE` SQLite transaction on the single Node thread, so the count check and
insert are atomic. Tested with five simultaneous joins for three free slots.

### Signaling (`/api/jam/ws`)

1. Client gets a ticket over HTTPS, opens the socket (no credentials in the URL), sends
   `{type:"auth", v:1, ticket}` as the first frame within 5 s.
2. Anything else first, a bad ticket, or a used ticket closes with 4401. No room data before auth.
3. Browser `Origin` must be allowed. Native clients send no Origin and still need a ticket.
4. On auth the participant's generation increments. An older socket for the same participant is closed (4409).
5. Frames: `ping`, `state` (peer state + instrument revision), `signal` (offer, answer, candidate,
   end-of-candidates, restart). The server stamps `from` and `fromGeneration` from the socket and only
   forwards to a currently connected member of the same room whose generation and room epoch match.
6. Limits: 16 KiB frames, SDP 12k chars, 50 frames/s per participant, 200 unauthenticated sockets.

### Leases and host loss

A disconnected member is removed after `JAM_RECONNECT_GRACE_SECONDS` (60). A disconnected host is replaced
by the oldest connected member after `JAM_HOST_GRACE_SECONDS` (15). Rooms end at `JAM_ROOM_TTL_SECONDS`.
A 1 s sweep enforces all three.

### Restart and primary/standby

Presence, generations and tickets live in process memory. Each process has a random `serverEpoch`, sent in
every snapshot. Rooms and memberships survive a restart in `jam.sqlite`. Clients that see their socket drop
re-ticket and compare `serverEpoch`: a change means rebuild peer state from the new snapshot.
nginx does not retry jam upgrades on the other upstream, so an open socket never ends up split across
primary and standby. If the standby uses a different data dir its rooms are separate and clients see 404 and
must rejoin. No seamless failover is claimed.

### TURN

`ice-credentials` returns coturn `use-auth-secret` credentials: `username = <expiry>:<participantId>`,
`credential = base64(HMAC-SHA1(secret, username))`. The secret stays server-side. `JAM_RELAY_ONLY=1` sets
`iceTransportPolicy: "relay"`. coturn deployment config and docs come with the client PR.

## Smoke test

`scripts/jam-smoke.sh` starts a throwaway server and runs the full room flow (create, join by link and code,
4-player limit, revoke, kick, host transfer, offer/answer relay, TURN credentials, leave, end).
`JAM_SMOKE_BASE=https://staging... scripts/jam-smoke.sh` runs it against an existing server that has
`p1..p5:code-p1..code-p5` access codes.

## Web client

Route `/jam` (lobby) and `/jam/<roomId>#i=<invite>`. The invite is in the fragment, so it never reaches server logs
or the Referer header. The page drops it after joining.

| Module | Role |
|---|---|
| `src/jam/session.ts` | `JamSession`: the one owner of signaling, peers, clock, router, receivers, audio and timers. All injected |
| `src/jam/signaling-client.ts` | ticket per attempt, ticket as first frame, backoff with jitter, 60 s loss grace then `suspended`, pings |
| `src/jam/peer-manager.ts` | full mesh `RTCPeerConnection`s, data channels only, deterministic offerer, early-signal buffer, ICE restart, getStats |
| `src/jam/clock.ts` | room clock estimate |
| `src/jam/input-router.ts` | local capture: monitor once, send once, redundancy, snapshots, Web MIDI bytes |
| `src/jam/receive-scheduler.ts` | per-peer replay window, reconciler, adaptive budget, lease, toSynth via `synth-ingress` |
| `src/jam/reconciler.ts`, `dedupe.ts` | note safety and dedupe |
| `src/jam/audio.ts` | one AudioContext, one `sf2-processor` node per player (max 4), GainNode mix, AnalyserNode level |
| `src/components/jam/JamApp.tsx` | lobby, guest gate, room, player strips, instrument, keyboard, MIDI picker, host controls, panic, details |

Changed existing code: `sf2-processor-core.ts` (live queue), `sf2-processor.ts` (passes `currentFrame`),
`sf2-renderer.ts` (`renderScheduled` takes a start/end range; default unchanged), `midi-input.ts` (passes
`event.timeStamp`), `agent/routes.ts` + `Root.tsx` (`/jam` route, lazy loaded).

The jam keyboard and engines are separate from the studio's `LiveInputSession`/`Sf2LiveSink`. The jam page is its
own route, so the studio keyboard and player are not mounted while you jam. A Web MIDI controller is only attached
by the jam page while it is open.

## Open rooms and deep links

Rooms are private by default. The host can tick "Open to anyone" (`POST /api/jam/rooms/:id/open`). `POST /api/jam/rooms/random`
joins the caller to one open, unlocked, live room with a free slot, in one SQLite transaction like any other join.
It picks the fullest room first, never one the caller is already in, and returns `404 NO_OPEN_ROOM` when there is none.
`/jam/<roomId>#i=<invite>` and `/jam?code=XXXX` go straight into the room after sign-in or the guest step. If the browser
needs a gesture before playing audio, the room shows "Tap anywhere to turn on sound".
