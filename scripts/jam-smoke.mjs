// Live Jam room flow against a running server: node scripts/jam-smoke.mjs <base> <origin>
// Needs COMPOSER_ACCESS_CODES with p1..p5:code-p1..code-p5 on the server (scripts/jam-smoke.sh sets that up).
import WebSocket from "ws";
const base = process.argv[2] ?? "http://127.0.0.1:8787", origin = process.argv[3] ?? base;
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failed++; };
async function login(code) {
  const s = await fetch(`${base}/api/session`); const csrf = (await s.json()).csrf;
  const r = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json", origin, "x-gbk-csrf": csrf, cookie: `gbk_csrf=${csrf}` }, body: JSON.stringify({ code }) });
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "); const b = await r.json();
  return { cookie, csrf: b.csrf };
}
const api = (u) => async (method, path, body) => {
  const r = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", origin, "x-gbk-csrf": u.csrf, cookie: u.cookie }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
function openWs(ticket) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/jam/ws`, { headers: { origin } }); const q = []; const waiters = [];
    ws.on("message", (raw) => { const m = JSON.parse(String(raw)); const i = waiters.findIndex((w) => w.pred(m)); if (i >= 0) waiters.splice(i, 1)[0].res(m); else q.push(m); });
    const next = (pred, ms = 3000) => { const i = q.findIndex(pred); if (i >= 0) return Promise.resolve(q.splice(i, 1)[0]); return new Promise((r2, j) => { const w = { pred, res: r2 }; waiters.push(w); setTimeout(() => j(new Error("timeout")), ms); }); };
    ws.on("open", () => { ws.send(JSON.stringify({ type: "auth", v: 1, ticket })); next((m) => m.type === "welcome").then((w) => res({ ws, w, next, send: (m) => ws.send(JSON.stringify(m)) }), rej); });
    ws.on("error", rej);
  });
}

const users = await Promise.all([1, 2, 3, 4, 5].map((i) => login(`code-p${i}`)));
const [a, b, c, d, e] = users.map(api);
const created = await a("POST", "/api/jam/rooms", { name: "Host" });
ok(created.status === 200 && created.body.invite?.token && created.body.invite?.code, `create room -> ${created.status}`);
const room = created.body.snapshot.roomId, hostId = created.body.participantId, inv = created.body.invite;
const jb = await b("POST", `/api/jam/rooms/${room}/join`, { invite: inv.token, name: "B" });
ok(jb.status === 200, `join with invite link -> ${jb.status}`);
const jc = await c("POST", "/api/jam/join", { invite: inv.code.toLowerCase(), name: "C" });
ok(jc.status === 200 && jc.body.snapshot.roomId === room, `join with human code -> ${jc.status}`);
const jd = await d("POST", `/api/jam/rooms/${room}/join`, { invite: inv.token, name: "D" });
ok(jd.status === 200 && jd.body.snapshot.participants.length === 4, `4th player joins -> ${jd.status}, ${jd.body.snapshot?.participants.length} players`);
const je = await e("POST", `/api/jam/rooms/${room}/join`, { invite: inv.token, name: "E" });
ok(je.status === 409 && je.body.code === "ROOM_FULL", `5th player refused -> ${je.status} ${je.body.code}`);
const bid = jb.body.participantId, cid = jc.body.participantId, did = jd.body.participantId;

const rv = await a("POST", `/api/jam/rooms/${room}/invite/revoke`, { participantId: hostId });
ok(rv.status === 200, `revoke invites -> ${rv.status}`);
const kk = await a("POST", `/api/jam/rooms/${room}/kick`, { participantId: hostId, target: did });
ok(kk.status === 200, `kick D -> ${kk.status}`);
const je2 = await e("POST", `/api/jam/rooms/${room}/join`, { invite: inv.token });
ok(je2.status === 404 && je2.body.code === "INVITE_INVALID", `revoked invite refused (free slot) -> ${je2.status} ${je2.body.code}`);
const dGone = await d("GET", `/api/jam/rooms/${room}?participantId=${did}`);
ok(dGone.status === 404, `kicked D loses access -> ${dGone.status}`);

const ta = await a("POST", `/api/jam/rooms/${room}/ws-ticket`, { participantId: hostId });
const tb = await b("POST", `/api/jam/rooms/${room}/ws-ticket`, { participantId: bid });
const spoof = await b("POST", `/api/jam/rooms/${room}/ws-ticket`, { participantId: hostId });
ok(spoof.status === 404, `ticket for someone else's participant refused -> ${spoof.status}`);
const A = await openWs(ta.body.ticket), B = await openWs(tb.body.ticket);
ok(A.w.participantId === hostId && B.w.participantId === bid, `both peers authenticated on /api/jam/ws (gen A=${A.w.generation}, B=${B.w.generation})`);
const reuse = await openWs(ta.body.ticket).then(() => "accepted", (err) => "refused");
ok(reuse === "refused", `reused ticket ${reuse}`);
const epoch = A.w.snapshot.epoch;
A.send({ type: "signal", to: bid, toGeneration: B.w.generation, epoch, revision: 1, kind: "offer", sdp: "v=0 fake-offer" });
const off = await B.next((m) => m.type === "signal");
ok(off.kind === "offer" && off.from === hostId && off.sdp === "v=0 fake-offer", `offer relayed A -> B (from=${off.from === hostId ? "A" : off.from})`);
B.send({ type: "signal", to: hostId, toGeneration: A.w.generation, epoch, revision: 1, kind: "answer", sdp: "v=0 fake-answer" });
const ans = await A.next((m) => m.type === "signal");
ok(ans.kind === "answer" && ans.from === bid, "answer relayed B -> A");
B.send({ type: "signal", to: did, toGeneration: 1, epoch, revision: 1, kind: "offer", sdp: "x" });
const bad = await B.next((m) => m.type === "error");
ok(bad.code === "BAD_TARGET", `signal to non-member refused -> ${bad.code}`);

const ho = await a("POST", `/api/jam/rooms/${room}/host`, { participantId: hostId, target: bid });
ok(ho.status === 200, `transfer host A -> B -> ${ho.status}`);
const snap = await A.next((m) => m.type === "snapshot" && m.snapshot.hostId === bid);
ok(snap.snapshot.hostId === bid, "snapshot shows B as host");
const notHost = await a("POST", `/api/jam/rooms/${room}/kick`, { participantId: hostId, target: cid });
ok(notHost.status === 403, `old host can no longer kick -> ${notHost.status}`);

const ice = await b("POST", `/api/jam/rooms/${room}/ice-credentials`, { participantId: bid });
const srv = ice.body.iceServers?.[0];
ok(ice.status === 200 && srv?.username && srv?.credential && !JSON.stringify(ice.body).includes("smoke-turn-secret"), `TURN credentials -> ${ice.status}, user=${srv?.username}, ttl=${ice.body.ttlSec}s, policy=${ice.body.iceTransportPolicy}`);

const lv = await a("POST", `/api/jam/rooms/${room}/leave`, { participantId: hostId });
ok(lv.status === 200, `A leaves -> ${lv.status}`);
const left = await B.next((m) => m.type === "peer-left");
ok(left.participantId === hostId, "B told that A left");
const en = await b("POST", `/api/jam/rooms/${room}/end`, { participantId: bid });
ok(en.status === 200, `host B ends room -> ${en.status}`);
const endedMsg = await B.next((m) => m.type === "ended");
ok(endedMsg.reason === "host", "B socket got ended");
const after = await c("GET", `/api/jam/rooms/${room}?participantId=${cid}`);
ok(after.status === 404, `ended room is gone -> ${after.status}`);
A.ws.close(); B.ws.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall jam smoke checks passed");
process.exit(failed ? 1 : 0);
