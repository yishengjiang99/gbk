# Live Jam protocol v1

Three layers:

1. **Signaling**: JSON over `/api/jam/ws`. Schemas live in `shared/jam/signaling.ts`; flow in `architecture.md`.
2. **Events**: binary over the `jam.events.v1` data channel (`shared/jam/events.ts`).
3. **Control**: small JSON over the `jam.control.v1` data channel.

## Data channels

Both channels are pre-negotiated (`negotiated: true`), so both peers create the same channels and nobody waits
for `ondatachannel`.

| Label | id | Settings | Carries |
|---|---|---|---|
| `jam.events.v1` | 0 | `ordered: false`, `maxRetransmits: 0` | live MIDI events, redundant copies, snapshots/heartbeats |
| `jam.control.v1` | 1 | reliable, ordered | `hello`, `instrument`, `probe`, `probe-reply` |

`maxPacketLifeTime` is never set. The e2e test reads back `ordered=false, maxRetransmits=0` in Chromium.

Roles: the peer with the lexically lower `participantId` sends offers. The other peer only answers and asks for an
ICE restart with a `restart` signal. A link that is not up after 8 s gets an ICE restart. After 3 restarts it is rebuilt.
Signals from a peer we have not created yet (or from a newer generation than our snapshot shows) are buffered
(max 64) and replayed once the peer exists.

## Event packet

A packet holds 1 to 4 records of 28 bytes. Record 0 is new. Records 1 to 3 are the sender's most recent
critical events (note on/off, sustain/sostenuto, CC 120+), resent as-is. Receivers dedupe them by `seq`.
A snapshot record is 48 bytes and always travels alone. Max packet size is 1200 bytes. All values are little-endian.

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | u8 | version | 1 |
| 1 | u8 | kind | 1 note on, 2 note off, 3 CC, 4 pitch bend, 5 channel pressure, 6 poly pressure, 7 program, 8 panic, 9 snapshot |
| 2 | u16 | generation | sender's signaling connection generation, low 16 bits |
| 4 | u32 | seq | per-sender sequence, wraps; compared with serial arithmetic. Snapshots carry the as-of watermark here instead and use no sequence number of their own |
| 8 | f64 | roomTimeUs | capture time in the room clock, integer microseconds (always a safe integer; decoder rejects others) |
| 16 | u8 | channel | 0..15 (v1 senders use 0: one instrument per player) |
| 17 | u8 | a | note / controller / pressure / bend LSB, 0..127 |
| 18 | u8 | b | velocity / value / bend MSB, 0..127 |
| 19 | u8 | stream | local source: 0 on-screen/computer keys, 1 Web MIDI |
| 20 | u32 | noteId | note instance id for note on/off, else 0 |
| 24 | u16 | instrumentRevision | |
| 26 | u16 | clockRevision | sender's clock-estimate revision |
| 28 | 16 B | held | snapshot only: 128-bit held-key map, bit `n & 7` of byte `n >> 3` |
| 44 | u8 | sustain | snapshot only: last CC64 value |
| 45 | u8 | sostenuto | snapshot only: last CC66 value |
| 46 | u16 | reserved | 0 |

Decoder rejects: short records, wrong version, unknown kind, channel > 15 or data bytes > 127, non-integer time,
packets over 1200 bytes, more than 4 records, or a snapshot record mixed with others.

Fixtures: `test/fixtures/jam/events-v1.json` (hex plus decoded JSON). The TypeScript test checks byte-for-byte
equality; the Swift codec will use the same file.

## Note safety

Each receiver keeps one reconciler per sender and generation (`src/jam/reconciler.ts`):

- A duplicate `noteId` attack is ignored.
- A release that arrives before its attack leaves a tombstone (max 64). The attack is then dropped.
- Retrigger on a held key: the old instance is released first. A late release of an older instance is ignored.
- Snapshots (sent every 250 ms, also the heartbeat) release keys that were up as of the watermark and fix pedal
  state. A snapshot never creates a note: a lost attack stays lost rather than becoming an unrelated late note.
- No packet from a sender for 1 s: its notes and pedals are released (lease). Heartbeats keep long held chords alive.
- A new generation (the sender reconnected) releases the old stream and resets the replay window.
- Replay window of 1024 sequence numbers: reordering is accepted once; older packets are dropped.

Engine limit: the SF2 engine releases by channel and pitch, not by note id. Isolation works because every player has
a separate engine (worklet node), and the reconciler guarantees the release order per key matches the attacks.

## Timing

- Capture time comes from `KeyboardEvent.timeStamp`, `PointerEvent.timeStamp`, or Web MIDI `event.timeStamp`
  (now passed through `MidiInputManager`). All are in the `performance.now()` domain.
- Room clock = the signaling server's `performance.now()`. Each client pings once a second. Each sample gives
  `rtt = t3 - t0` and `offset = ts - (t0 + t3) / 2`. The estimate is the median offset of samples with
  `rtt <= 1.5 * minRtt + 1`. Uncertainty is `minRtt / 2` plus half the spread. A gap over 10 s resets it; a new
  `serverEpoch` rebases it.
- Per-sender delay budget = p95 of `(arrival - capture)` over the last 64 events, plus 5 ms jitter allowance, max 80 ms.
  The budget grows at once and shrinks by 0.5 ms per second.
- Target time = capture + budget. That is mapped to an AudioContext frame with `ClockDomainMap`, fed from
  `getOutputTimestamp()` (or `currentTime` minus `baseLatency` when that is missing).
- An attack more than 40 ms past its target is dropped and counted. Releases, pedals and panic always go
  through, as soon as possible.
- Committed times per sender never move backwards.
- Labels: under 20 ms budget and under 1% loss = "Tight"; under 40 ms and under 5% = "Playable"; otherwise "Laggy".
  Fewer than 5 samples = "Measuring…".

## Worklet live queue

`Sf2ProcessorCore` has a separate sorted queue of `{frame, event}` with absolute context frames
(`liveEvent`, `liveEvents`, `liveClear`, `livePanic`, `liveStats`). Capacity is 512. `process()` splits the render
quantum at each event's offset, so an early event lands on its exact frame (tested to the sample). Late events
apply at the start of the next quantum and are counted. When the queue is full, attacks are dropped and anything
else is applied immediately. `livePanic` clears the queue and sends CC64/66 = 0, CC123 and CC120 on all channels.
The SMF sequence path is unchanged.
