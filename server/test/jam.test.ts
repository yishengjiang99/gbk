import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startServer, login } from "./ws-helpers.ts";
import { ScriptModel, reply, testConfig } from "./helpers.ts";
import { turnCredentials, verifyTurnCredential } from "../src/jam/turn.ts";
import { decodeClientFrame } from "../../shared/jam/signaling.ts";

const CODES = { COMPOSER_ACCESS_CODES: "alice:code-a,bob:code-b,carol:code-c,dan:code-d,erin:code-e,fay:code-f", JAM_TURN_URLS: "turn:turn.test:3478", JAM_TURN_SHARED_SECRET: "s".repeat(24), RATE_IP_PER_MINUTE: "1000", RATE_LOGIN_PER_MINUTE: "100" };
const ORIGIN = "http://composer.test";
type U = { cookie: string; csrf: string };
const call = (base: string, u: U, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", origin: ORIGIN, "x-gbk-csrf": u.csrf, cookie: u.cookie, ...extra }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() as any }));
async function setup(over: Record<string, string> = {}) {
  const srv = await startServer(new ScriptModel([() => reply("hi")]), { ...CODES, ...over });
  const users = await Promise.all(["a", "b", "c", "d", "e", "f"].map((x) => login(srv.base, `code-${x}`)));
  return { srv, users };
}
function rawWs(base: string, origin: string | undefined = ORIGIN) {
  const ws = new WebSocket(`${base.replace("http", "ws")}/api/jam/ws`, { headers: origin ? { origin } : {} }); const msgs: any[] = [];
  ws.on("message", (r) => msgs.push(JSON.parse(String(r))));
  const closed = new Promise<number>((ok) => ws.on("close", (c) => ok(c)));
  const opened = new Promise<void>((ok, fail) => { ws.on("open", () => ok()); ws.on("unexpected-response", (_q, res) => fail(new Error(`HTTP ${res.statusCode}`))); ws.on("error", fail); });
  const wait = async (pred: (m: any) => boolean, ms = 2000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = msgs.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 10)); } throw new Error("timeout"); };
  return { ws, msgs, closed, opened, wait, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

test("concurrent last-slot joins: exactly maxParticipants members", async () => {
  const { srv, users } = await setup();
  try {
    const c = await call(srv.base, users[0], "POST", "/api/jam/rooms", {});
    const room = c.body.snapshot.roomId;
    const rs = await Promise.all(users.slice(1).map((u) => call(srv.base, u, "POST", `/api/jam/rooms/${room}/join`, { invite: c.body.invite.token })));
    assert.equal(rs.filter((r) => r.status === 200).length, 3);
    assert.ok(rs.filter((r) => r.status === 409).every((r) => r.body.code === "ROOM_FULL"));
    const snap = await call(srv.base, users[0], "GET", `/api/jam/rooms/${room}?participantId=${c.body.participantId}`);
    assert.equal(snap.body.snapshot.participants.length, 4);
  } finally { await srv.app.close(); }
});

test("auth: CSRF + Origin on writes, bearer for native, one account on two devices, no enumeration", async () => {
  const { srv, users } = await setup();
  try {
    const noCsrf = await fetch(`${srv.base}/api/jam/rooms`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, cookie: users[0].cookie }, body: "{}" });
    assert.equal(noCsrf.status, 403);
    const anon = await fetch(`${srv.base}/api/jam/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(anon.status, 401);
    const token = users[0].cookie.match(/gbk_cs=([^;]+)/)![1];
    const viaBearer = await fetch(`${srv.base}/api/jam/rooms`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${decodeURIComponent(token)}` }, body: "{}" }).then(async (r) => ({ status: r.status, body: await r.json() as any }));
    assert.equal(viaBearer.status, 200);
    const room = viaBearer.body.snapshot.roomId;
    // Same account, second device: a distinct participant.
    const dev2 = await call(srv.base, users[0], "POST", `/api/jam/rooms/${room}/join`, { invite: viaBearer.body.invite.token });
    assert.equal(dev2.status, 200); assert.notEqual(dev2.body.participantId, viaBearer.body.participantId);
    // Resuming my own participant does not consume a slot; resuming someone else's is just a normal join.
    const again = await call(srv.base, users[0], "POST", `/api/jam/rooms/${room}/join`, { invite: viaBearer.body.invite.token, participantId: dev2.body.participantId });
    assert.equal(again.body.participantId, dev2.body.participantId);
    const notMine = await call(srv.base, users[1], "GET", `/api/jam/rooms/${room}?participantId=${dev2.body.participantId}`);
    const unknown = await call(srv.base, users[1], "GET", `/api/jam/rooms/nope?participantId=p1`);
    assert.equal(notMine.status, 404); assert.equal(unknown.status, 404); assert.equal(notMine.body.code, unknown.body.code);
    const badInvite = await call(srv.base, users[1], "POST", `/api/jam/rooms/${room}/join`, { invite: "wrong-invite-token" });
    assert.equal(badInvite.status, 404);
  } finally { await srv.app.close(); }
});

test("rotate invalidates old invites; lock blocks joins; member cannot use host controls", async () => {
  const { srv, users } = await setup();
  try {
    const c = await call(srv.base, users[0], "POST", "/api/jam/rooms", {}); const room = c.body.snapshot.roomId, host = c.body.participantId;
    const j = await call(srv.base, users[1], "POST", `/api/jam/rooms/${room}/join`, { invite: c.body.invite.code });
    assert.equal((await call(srv.base, users[1], "POST", `/api/jam/rooms/${room}/invite`, { participantId: j.body.participantId })).status, 403);
    const rot = await call(srv.base, users[0], "POST", `/api/jam/rooms/${room}/invite`, { participantId: host });
    assert.equal((await call(srv.base, users[2], "POST", `/api/jam/rooms/${room}/join`, { invite: c.body.invite.token })).status, 404);
    await call(srv.base, users[0], "POST", `/api/jam/rooms/${room}/lock`, { participantId: host });
    assert.equal((await call(srv.base, users[2], "POST", `/api/jam/rooms/${room}/join`, { invite: rot.body.invite.token })).body.code, "ROOM_LOCKED");
    await call(srv.base, users[0], "POST", `/api/jam/rooms/${room}/unlock`, { participantId: host });
    assert.equal((await call(srv.base, users[2], "POST", `/api/jam/rooms/${room}/join`, { invite: rot.body.invite.token })).status, 200);
  } finally { await srv.app.close(); }
});

test("signaling: pre-auth frames rejected, bad origin refused, generation bump replaces old socket", async () => {
  const { srv, users } = await setup();
  try {
    const evil = rawWs(srv.base, "http://evil.test"); await assert.rejects(evil.opened, /403/);
    const early = rawWs(srv.base); await early.opened;
    early.send({ type: "signal", to: "p1", toGeneration: 1, epoch: 1, revision: 1, kind: "offer", sdp: "x" });
    assert.equal(await early.closed, 4401); assert.equal(early.msgs[0].code, "AUTH_REQUIRED");
    const garbage = rawWs(srv.base); await garbage.opened; garbage.send({ type: "auth", v: 1, ticket: "x".repeat(40) });
    assert.equal(await garbage.closed, 4401); assert.equal(garbage.msgs[0].code, "AUTH_FAILED");
    const c = await call(srv.base, users[0], "POST", "/api/jam/rooms", {}); const room = c.body.snapshot.roomId, pid = c.body.participantId;
    const t1 = await call(srv.base, users[0], "POST", `/api/jam/rooms/${room}/ws-ticket`, { participantId: pid });
    const native = rawWs(srv.base, undefined); await native.opened; native.send({ type: "auth", v: 1, ticket: t1.body.ticket });
    const w1 = await native.wait((m) => m.type === "welcome"); assert.equal(w1.generation, 1);
    const t2 = await call(srv.base, users[0], "POST", `/api/jam/rooms/${room}/ws-ticket`, { participantId: pid });
    const second = rawWs(srv.base); await second.opened; second.send({ type: "auth", v: 1, ticket: t2.body.ticket });
    assert.equal((await second.wait((m) => m.type === "welcome")).generation, 2);
    assert.equal(await native.closed, 4409);
    second.send({ type: "ping", t: 5 }); assert.equal((await second.wait((m) => m.type === "pong")).t, 5);
    second.send({ type: "nope" }); assert.equal((await second.wait((m) => m.type === "error")).code, "BAD_FRAME");
    second.ws.close();
  } finally { await srv.app.close(); }
});

test("metronome: host sets a future-anchored transport, everyone gets it, members cannot", async () => {
  const { srv, users } = await setup();
  try {
    const c = await call(srv.base, users[0], "POST", "/api/jam/rooms", {}); const room = c.body.snapshot.roomId;
    assert.equal(c.body.snapshot.transport.running, false);
    const j = await call(srv.base, users[1], "POST", `/api/jam/rooms/${room}/join`, { invite: c.body.invite.token });
    const open = async (u: U, pid: string) => { const t = await call(srv.base, u, "POST", `/api/jam/rooms/${room}/ws-ticket`, { participantId: pid }); const w = rawWs(srv.base); await w.opened; w.send({ type: "auth", v: 1, ticket: t.body.ticket }); await w.wait((m) => m.type === "welcome"); return w; };
    const h = await open(users[0], c.body.participantId), m = await open(users[1], j.body.participantId);
    m.send({ type: "transport", running: true, bpm: 90, beatsPerBar: 3, countInBars: 1 });
    assert.equal((await m.wait((x) => x.type === "error")).code, "NOT_HOST");
    h.send({ type: "ping", t: 1 }); const pong = await h.wait((x) => x.type === "pong");
    h.send({ type: "transport", running: true, bpm: 90, beatsPerBar: 3, countInBars: 1 });
    const s = (await m.wait((x) => x.type === "snapshot" && x.snapshot.transport.running)).snapshot.transport;
    assert.equal(s.bpm, 90); assert.equal(s.beatsPerBar, 3); assert.equal(s.anchorBeat, -3); assert.ok(s.anchorRoomTime > pong.serverTime);
    h.send({ type: "transport", running: true, bpm: 500, beatsPerBar: 3, countInBars: 1 });
    assert.equal((await h.wait((x) => x.type === "error")).code, "BAD_FRAME");
    h.ws.close(); m.ws.close();
  } finally { await srv.app.close(); }
});

test("agent WebSocket still upgrades alongside jam; unknown upgrade paths destroyed", async () => {
  const { srv, users } = await setup();
  try {
    const ws = new WebSocket(`${srv.base.replace("http", "ws")}/api/agent/ws`, { headers: { cookie: users[0].cookie, origin: ORIGIN } });
    await new Promise<void>((ok, fail) => { ws.on("open", () => ok()); ws.on("error", fail); }); ws.close();
    const other = new WebSocket(`${srv.base.replace("http", "ws")}/api/nope/ws`);
    await new Promise<void>((ok) => { other.on("error", () => ok()); other.on("close", () => ok()); });
  } finally { await srv.app.close(); }
});

test("TURN unconfigured answers 503", async () => {
  const noTurn = await setup({ JAM_TURN_URLS: "" });
  try {
    const c = await call(noTurn.srv.base, noTurn.users[0], "POST", "/api/jam/rooms", {});
    const r = await call(noTurn.srv.base, noTurn.users[0], "POST", `/api/jam/rooms/${c.body.snapshot.roomId}/ice-credentials`, { participantId: c.body.participantId });
    assert.equal(r.status, 503); assert.equal(r.body.code, "TURN_UNCONFIGURED");
  } finally { await noTurn.srv.app.close(); }
});

test("TURN credentials: HMAC verifies, expire, never contain the secret", () => {
  const secret = "k".repeat(24); const now = 1_800_000_000_000;
  const c = turnCredentials({ urls: ["turn:x:3478"], secret, ttlSec: 600, relayOnly: true, subject: "p1", nowMs: now });
  const s = c.iceServers[0];
  assert.equal(c.iceTransportPolicy, "relay"); assert.ok(!JSON.stringify(c).includes(secret));
  assert.ok(verifyTurnCredential(secret, s.username!, s.credential!, now));
  assert.ok(!verifyTurnCredential(secret, s.username!, s.credential!, now + 601_000));
  assert.ok(!verifyTurnCredential("other".repeat(5), s.username!, s.credential!, now));
});

test("config validation and frame codec bounds", () => {
  assert.throws(() => testConfig({ JAM_MAX_PARTICIPANTS: "6" }), /2\.\.4/);
  assert.throws(() => testConfig({ JAM_TURN_URLS: "turn:x", JAM_TURN_SHARED_SECRET: "short" }), /SHARED_SECRET/);
  assert.equal(testConfig().jam.maxParticipants, 4);
  assert.equal(decodeClientFrame("x".repeat(20_000)).ok, false);
  const pm = decodeClientFrame(JSON.stringify({ type: "auth", v: 2, ticket: "x".repeat(20) }));
  assert.ok(!pm.ok && pm.code === "PROTOCOL_MISMATCH");
  assert.equal(decodeClientFrame(JSON.stringify({ type: "signal", to: "../x", toGeneration: 1, epoch: 1, revision: 0, kind: "offer" })).ok, false);
});
