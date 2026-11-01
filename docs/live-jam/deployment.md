# Live Jam deployment

Live Jam needs two things on top of the normal GBK stack: the jam settings in `/etc/gbk-composer.env`, and a TURN
relay for players who can't connect directly. The app works without TURN; those players just can't join.

## Pieces

| Piece | Where | Ports |
| --- | --- | --- |
| Rooms + signaling | agent (`/api/jam/*`, `/api/jam/ws` through nginx) | 443 via nginx |
| TURN (coturn) | `turn` service in `deploy/docker-compose.yml`, host network | 3478 udp+tcp, 443 tcp (TURNS), 49160–49200 udp |

TURN must not sit behind nginx or any HTTP proxy. It needs its own public IP, or at least its own ports.

## Setup

1. DNS: point `turn.example.com` (A/AAAA) at the TURN host's public IP.
2. TLS for TURNS on 443: get a certificate for `turn.example.com` and put `fullchain.pem` and `privkey.pem` in
   `/etc/gbk-turn-certs/`, readable by the container. If nginx already uses 443 on that IP, give TURN a second IP or
   leave out the `turns:` URL.
3. Secret: generate one with `openssl rand -base64 36`. Put it in `/etc/gbk-turn.env` (copy
   `deploy/turn.env.example`, mode 600) as `TURN_SHARED_SECRET`, along with `TURN_EXTERNAL_IP` and `TURN_REALM`.
4. App: in `/etc/gbk-composer.env`, set `JAM_TURN_SHARED_SECRET` to the same value and set `JAM_TURN_URLS`, for example
   `turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:443?transport=tcp`.
5. Firewall: open 3478/udp, 3478/tcp, 443/tcp and 49160–49200/udp on the TURN host. The relay range sets the capacity;
   each active relayed player uses about one port per peer.
6. Start the relay with `docker compose --profile turn up -d turn`, then restart the agent so it picks up the env.

The agent never hands out the secret. `/api/jam/rooms/:id/ice` returns short-lived REST credentials:
username `<expiry>:<participantId>`, password `base64(HMAC-SHA1(secret, username))`, valid for
`JAM_TURN_CREDENTIAL_TTL_SECONDS`, which defaults to one hour.

`deploy/coturn/turnserver.conf` denies relaying to loopback, private and link-local ranges, so the relay can't be
used to reach the host's internal network. It also sets per-user and total quotas.

## Check it

- Run `scripts/jam-smoke.sh` against the server for the room flow.
- Relay path: in a room, open "Connection details". A relayed peer shows `relay/udp` (or `relay/tcp`).
- Forced relay: set `JAM_RELAY_ONLY=1` temporarily. Every client then uses relay only, so a working room proves
  TURN works. Turn it back off afterwards, because direct paths have lower latency.
- e2e through a local coturn:
  `JAM_E2E_RELAY=1 TURNSERVER=/path/to/turnserver npx playwright test --config test/e2e/jam.config.ts`.
  This starts `scripts/jam-turn-local.sh` on 127.0.0.1:3478. That script allows loopback peers, which is only
  safe for local tests.

## Rotate the secret

coturn takes one `static-auth-secret`, so rotating it briefly breaks credentials that were already issued:

1. Write the new secret to both env files.
2. Restart `turn`, then the agent.
3. Clients fetch new credentials when they reconnect or restart ICE. Do this when few rooms are open.

## Monitoring

- coturn logs to stdout (`docker compose logs turn`).
- Metrics: add `prometheus` to the config if your coturn build supports it (port 9641, keep it private). Otherwise
  watch the allocation lines in the log.
- On the app side, the agent logs room counts and signaling errors. The client's "Connection details" panel shows the
  path, RTT and loss for each peer.

## Rollback

- Turn TURN off: `docker compose --profile turn stop turn` and clear `JAM_TURN_URLS`. Direct connections keep
  working; `/ice` answers 503, and players who need a relay can't connect.
- Live Jam itself has no off switch; roll back to the previous release to remove it.
