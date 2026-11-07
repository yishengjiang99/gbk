import test from "node:test";
import assert from "node:assert/strict";
import { JamRooms, JamError, type JamLimits } from "../src/jam/rooms.ts";
import { startServer, login } from "./ws-helpers.ts";
import { ScriptModel, reply } from "./helpers.ts";
import { decodeClientFrame } from "../../shared/jam/signaling.ts";
import WebSocket from "ws";

const LIM: JamLimits = { maxParticipants: 4, roomTtlSec: 6 * 3600, inviteTtlSec: 3600, codeTtlSec: 3600, maxRoomsPerIdentity: 3 };

test("Jam room flags are orthogonal: live-unlisted default, open+locked is not randomly joinable, lock blocks invites, expiry sweep sets ended_at", () => {
  let t = 1_000_000;
  const rooms = new JamRooms(":memory:", LIM, () => t);
  const created = rooms.create("alice", "Alice");
  const roomId = created.snapshot.roomId;
  const host = created.participantId;
  assert.equal(created.snapshot.open, false);
  assert.equal(created.snapshot.locked, false);
  assert.throws(() => rooms.joinRandom("bob", "Bob"), (e: JamError) => e.code === "NO_OPEN_ROOM");

  rooms.setOpen(roomId, "alice", host, true);
  const random = rooms.joinRandom("bob", "Bob");
  assert.equal(random.snapshot.roomId, roomId);

  rooms.setLocked(roomId, "alice", host, true);
  assert.equal(rooms.snapshot(roomId).open, true);
  assert.equal(rooms.snapshot(roomId).locked, true);
  assert.throws(() => rooms.joinRandom("carol", "Carol"), (e: JamError) => e.code === "NO_OPEN_ROOM");
  assert.throws(() => rooms.join(roomId, "carol", "Carol", created.invite.token), (e: JamError) => e.code === "ROOM_LOCKED");

  t = created.snapshot.expiresAt + 1;
  const swept = rooms.sweep();
  assert.equal(swept.length, 1);
  assert.equal(swept[0]!.roomId, roomId);
  const row = rooms.db.prepare("SELECT ended_at FROM jam_rooms WHERE id = ?").get(roomId) as { ended_at: number | null };
  assert.ok(row.ended_at, "sweep writes ended_at");
  assert.throws(() => rooms.join(roomId, "dan", "Dan", created.invite.token), (e: JamError) => e.code === "INVITE_INVALID");
  rooms.close();
});

test("disconnect marks reconnecting, generation bumps on connect, stale grace lists the member", () => {
  let t = 1_000_000;
  const rooms = new JamRooms(":memory:", LIM, () => t);
  const created = rooms.create("alice", "Alice");
  const pid = created.participantId;
  const g1 = rooms.connect(pid);
  assert.equal(g1, 1);
  assert.equal(rooms.presenceOf(pid).state, "joining");
  rooms.disconnect(pid, g1);
  assert.equal(rooms.presenceOf(pid).connected, false);
  assert.equal(rooms.presenceOf(pid).state, "reconnecting");
  assert.deepEqual(rooms.stale(60_000), []);
  t += 60_000;
  assert.deepEqual(rooms.stale(60_000), [{ roomId: created.snapshot.roomId, pid }]);
  const g2 = rooms.connect(pid);
  assert.equal(g2, 2);
  assert.equal(rooms.presenceOf(pid).connected, true);
  rooms.close();
});

const CODES = { COMPOSER_ACCESS_CODES: "alice:code-a,bob:code-b,carol:code-c,dan:code-d,erin:code-e,fay:code-f", JAM_TURN_URLS: "turn:turn.test:3478", JAM_TURN_SHARED_SECRET: "s".repeat(24), RATE_IP_PER_MINUTE: "1000", RATE_LOGIN_PER_MINUTE: "100" };
const ORIGIN = "http://composer.test";
type U = { cookie: string; csrf: string };
const call = (base: string, u: U, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", origin: ORIGIN, "x-gbk-csrf": u.csrf, cookie: u.cookie }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() as any }));
function rawWs(base: string, origin: string | undefined = ORIGIN) {
  const ws = new WebSocket(`${base.replace("http", "ws")}/api/jam/ws`, { headers: origin ? { origin } : {} }); const msgs: any[] = [];
  ws.on("message", (r) => msgs.push(JSON.parse(String(r))));
  const opened = new Promise<void>((ok, fail) => { ws.on("open", () => ok()); ws.on("unexpected-response", (_q, res) => fail(new Error(`HTTP ${res.statusCode}`))); ws.on("error", fail); });
  const wait = async (pred: (m: any) => boolean, ms = 2000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = msgs.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 10)); } throw new Error("timeout"); };
  return { ws, msgs, opened, wait, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

test("signaling: illegal left self-report is rejected; legal states and degraded still apply; peers cannot flip each other", async () => {
  assert.equal(decodeClientFrame(JSON.stringify({ type: "state", state: "left" })).ok, true, "left is still a valid wire state");
  const srv = await startServer(new ScriptModel([() => reply("hi")]), CODES);
  try {
    const users = await Promise.all(["a", "b"].map((x) => login(srv.base, `code-${x}`)));
    const c = await call(srv.base, users[0], "POST", "/api/jam/rooms", {});
    const room = c.body.snapshot.roomId;
    const j = await call(srv.base, users[1], "POST", `/api/jam/rooms/${room}/join`, { invite: c.body.invite.token });
    const open = async (u: U, pid: string) => { const t = await call(srv.base, u, "POST", `/api/jam/rooms/${room}/ws-ticket`, { participantId: pid }); const w = rawWs(srv.base); await w.opened; w.send({ type: "auth", v: 1, ticket: t.body.ticket }); await w.wait((m) => m.type === "welcome"); return w; };
    const h = await open(users[0], c.body.participantId), m = await open(users[1], j.body.participantId);
    h.send({ type: "state", state: "left", instrumentRevision: 4 });
    const err = await h.wait((x) => x.type === "error");
    assert.equal(err.code, "BAD_FRAME");
    assert.match(err.message, /left/);
    const afterLeft = await m.wait((x) => x.type === "snapshot" && x.snapshot.participants.some((p: { participantId: string; instrumentRevision: number }) => p.participantId === c.body.participantId && p.instrumentRevision === 4));
    const host = afterLeft.snapshot.participants.find((p: { participantId: string }) => p.participantId === c.body.participantId);
    assert.notEqual(host.state, "left");
    assert.equal(host.instrumentRevision, 4);

    for (const state of ["preparing", "ready", "connecting", "degraded"] as const) {
      h.send({ type: "state", state });
      const snap = await m.wait((x) => x.type === "snapshot" && x.snapshot.participants.some((p: { participantId: string; state: string }) => p.participantId === c.body.participantId && p.state === state));
      const peer = snap.snapshot.participants.find((p: { participantId: string }) => p.participantId === j.body.participantId);
      assert.equal(peer.state, "joining", "a state frame only updates the sender");
    }
    h.ws.close(); m.ws.close();
  } finally { await srv.app.close(); }
});
