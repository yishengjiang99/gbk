// Live Jam web UI: lobby (create / join by link or code) and the room (players, instrument, keyboard, mix, panic).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import "./jam.css";
import { appUrl, navigate } from "../../agent/routes.ts";
import { continueAsGuest, ensureSession, jamApi, JamApiError, type Invite } from "../../jam/api.ts";
import { JamSession } from "../../jam/session.ts";
import { WebJamAudio } from "../../jam/audio.ts";
import { PeerManager } from "../../jam/peer-manager.ts";
import { SignalingClient, browserSignalingDeps } from "../../jam/signaling-client.ts";
import { MidiInputManager } from "../../workstation/midi-input.ts";
import { connectionLabel, fmtMs } from "../../jam/diagnostics.ts";
import { serializeSmf } from "../../workstation/smf.ts";
import { midiFileStore } from "../../midi-file-store.ts";
import { PROJECT_SCHEMA_VERSION } from "../../workstation/model.ts";

export const INSTRUMENTS = [
  { name: "Grand piano", bank: 0, program: 0 }, { name: "Electric piano", bank: 0, program: 4 }, { name: "Organ", bank: 0, program: 16 },
  { name: "Nylon guitar", bank: 0, program: 24 }, { name: "Electric bass", bank: 0, program: 33 }, { name: "Strings", bank: 0, program: 48 },
  { name: "Trumpet", bank: 0, program: 56 }, { name: "Synth lead", bank: 0, program: 80 }, { name: "Warm pad", bank: 0, program: 89 }, { name: "Drum kit", bank: 128, program: 0 },
];
const ERR: Record<string, string> = { ROOM_FULL: "That room is full (4 players max).", INVITE_INVALID: "That invite has expired or was revoked. Ask the host for a new one.", ROOM_LOCKED: "The host locked this room.", NOT_FOUND: "That room no longer exists.", RATE_LIMITED: "Too many tries. Wait a minute and try again.", UNAUTHENTICATED: "Sign in or continue as a guest first." };
const msg = (e: unknown) => e instanceof JamApiError ? (ERR[e.code] ?? e.message) : (e as Error).message;
const storeKey = (roomId: string) => `gbk.jam.${roomId}`;
interface Stored { participantId: string; invite?: Invite }
const loadStored = (roomId: string): Stored | null => { try { return JSON.parse(sessionStorage.getItem(storeKey(roomId)) ?? "null"); } catch { return null; } };
const inviteFromHash = () => new URLSearchParams(location.hash.slice(1)).get("i") ?? "";

export default function JamApp({ roomId }: { roomId: string | null }) {
  const [auth, setAuth] = useState<{ ok: boolean; name: string | null } | null>(null);
  useEffect(() => { void ensureSession().then((s) => setAuth({ ok: s.authenticated, name: s.name })).catch(() => setAuth({ ok: false, name: null })); }, []);
  if (!auth) return <div className="jam-page"><p>Loading…</p></div>;
  if (!auth.ok) return <div className="jam-page"><JamHeader /><GuestGate onDone={() => setAuth({ ok: true, name: null })} /></div>;
  return <div className="jam-page"><JamHeader />{roomId ? <RoomGate roomId={roomId} /> : <Lobby />}</div>;
}
function JamHeader() { return <header className="jam-header"><a href={appUrl("studio")}>← Studio</a><h1>Live Jam</h1></header>; }

function GuestGate({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState(""); const [err, setErr] = useState("");
  return <section className="jam-card"><p>Play live with up to 3 friends. Sign in, or join as a guest.</p>
    <label>Guest name (two words, like MellowFox) <input data-testid="jam-guest-name" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} /></label>
    <button data-testid="jam-guest" onClick={() => continueAsGuest(name).then(onDone, (e) => setErr(msg(e)))}>Continue as guest</button>
    <a href={appUrl("studio")}>Sign in instead</a>{err && <p role="alert" className="jam-err">{err}</p>}</section>;
}

function Lobby() {
  const [code, setCode] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const create = async () => { setBusy(true); setErr(""); try { const r = await jamApi.create(); sessionStorage.setItem(storeKey(r.snapshot.roomId), JSON.stringify({ participantId: r.participantId, invite: r.invite })); navigate(`jam/${r.snapshot.roomId}`); } catch (e) { setErr(msg(e)); } finally { setBusy(false); } };
  const join = async () => { setBusy(true); setErr(""); try { const r = await jamApi.join(null, code); sessionStorage.setItem(storeKey(r.snapshot.roomId), JSON.stringify({ participantId: r.participantId })); navigate(`jam/${r.snapshot.roomId}`); } catch (e) { setErr(msg(e)); } finally { setBusy(false); } };
  return <section className="jam-card">
    <button data-testid="jam-create" disabled={busy} onClick={create}>Create a room</button>
    <div className="jam-row"><input data-testid="jam-code" placeholder="Room code" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Room code" /><button data-testid="jam-join-code" disabled={busy || code.trim().length < 6} onClick={join}>Join</button></div>
    {err && <p role="alert" className="jam-err">{err}</p>}
  </section>;
}

/** Resolves membership (stored participant, or redeem the #i= invite after a click), then starts the session on a user gesture. */
function RoomGate({ roomId }: { roomId: string }) {
  const [stored, setStored] = useState<Stored | null>(() => loadStored(roomId)); const [err, setErr] = useState(""); const [session, setSession] = useState<JamSession | null>(null);
  const audio = useMemo(() => new WebJamAudio(), []);
  const start = useCallback(async () => {
    setErr("");
    try {
      let s = stored;
      if (!s) { const inv = inviteFromHash(); if (!inv) throw new Error("This link has no invite. Ask the host for a new one."); const r = await jamApi.join(roomId, inv); s = { participantId: r.participantId }; sessionStorage.setItem(storeKey(roomId), JSON.stringify(s)); history.replaceState(null, "", location.pathname); setStored(s); }
      else { await jamApi.snapshot(roomId, s.participantId); }
      await audio.start();
      const pid = s.participantId;
      const signaling = new SignalingClient(browserSignalingDeps(() => jamApi.ticket(roomId, pid)));
      const sess = new JamSession({ roomId, participantId: pid, signaling, audio, now: () => performance.now(), every: (f, ms) => { const t = setInterval(f, ms); return () => clearInterval(t); },
        makePeers: (cb) => new PeerManager({ ...cb, ice: () => jamApi.ice(roomId, pid) }) });
      sess.start(); await sess.setInstrument(0, 0); setSession(sess);
      (window as unknown as { __gbkJam?: JamSession; __gbkJamAudio?: WebJamAudio }).__gbkJam = sess; (window as unknown as { __gbkJamAudio?: WebJamAudio }).__gbkJamAudio = audio; // read-only hooks for diagnostics and e2e
    } catch (e) { if (e instanceof JamApiError && e.status === 404) { sessionStorage.removeItem(storeKey(roomId)); setStored(null); } setErr(msg(e)); }
  }, [roomId, stored, audio]);
  useEffect(() => () => session?.teardown(), [session]);
  useEffect(() => () => audio.close(), [audio]);
  if (session) return <Room session={session} roomId={roomId} invite={stored?.invite} />;
  return <section className="jam-card"><p>{stored ? "Ready to rejoin this room." : "You're invited to a Live Jam room."} Sound starts when you press the button.</p>
    <button data-testid="jam-enter" onClick={start}>{stored ? "Enter room" : "Join room"}</button>{err && <p role="alert" className="jam-err">{err}</p>}</section>;
}

function useSession(s: JamSession) { const [, set] = useState(0); useEffect(() => s.subscribe(() => set((n) => n + 1)), [s]); return s; }

function Room({ session, roomId, invite: firstInvite }: { session: JamSession; roomId: string; invite?: Invite }) {
  useSession(session);
  const [invite, setInvite] = useState(firstInvite); const [err, setErr] = useState(""); const [diag, setDiag] = useState(false);
  const snap = session.snapshot; const me = session.selfId; const host = session.isHost;
  const act = (f: () => Promise<unknown>) => () => { setErr(""); f().catch((e) => setErr(msg(e))); };
  const link = invite ? `${location.origin}${appUrl(`jam/${roomId}`)}#i=${invite.token}` : "";
  if (session.phase === "kicked" || session.phase === "ended" || session.phase === "left")
    return <section className="jam-card"><p data-testid="jam-over">{session.phase === "kicked" ? "The host removed you from the room." : session.phase === "ended" ? "This room has ended." : "You left the room."}</p><button onClick={() => navigate("jam")}>Back to Live Jam</button></section>;
  return <section className="jam-room" data-testid="jam-room" data-phase={session.phase}>
    {session.phase === "reconnecting" && <p className="jam-banner">Reconnecting…</p>}
    {session.phase === "suspended" && <p className="jam-banner">Lost the connection to the room. <button onClick={() => location.reload()}>Retry</button></p>}
    <p className="jam-note">You hear yourself right away. Each other player arrives with their own small delay.</p>
    <div className="jam-strips">
      {snap?.participants.map((p) => {
        const self = p.participantId === me; const st = self ? null : session.peerStats(p.participantId);
        const inst = self ? session.myInstrument : session.instruments.get(p.participantId); const mix = session.mix.get(p.participantId) ?? { volume: 1, muted: false };
        const q = self ? null : !p.connected ? "offline" : (st?.receive?.quality ?? "unknown");
        return <div key={p.participantId} className="jam-strip" data-testid={`jam-strip-${self ? "me" : "peer"}`} data-received={session.received.get(p.participantId) ?? 0}>
          <strong>{p.name}{self ? " (you)" : ""}{p.role === "host" ? " ★" : ""}</strong>
          <span>{inst?.name || "Choosing…"}</span>
          {!self && <span className="jam-q" data-testid="jam-quality">{connectionLabel(q as never, st?.link?.relay ?? null)}</span>}
          <label>Volume <input type="range" min={0} max={1.5} step={0.05} value={mix.volume} onChange={(e) => session.setMix(p.participantId, Number(e.target.value), mix.muted)} aria-label={`${p.name} volume`} /></label>
          <button onClick={() => session.setMix(p.participantId, mix.volume, !mix.muted)} aria-pressed={mix.muted}>{mix.muted ? "Unmute" : "Mute"}</button>
          {host && !self && <><button onClick={act(() => jamApi.host(roomId, me, p.participantId))}>Make host</button><button onClick={act(() => jamApi.kick(roomId, me, p.participantId))}>Remove</button></>}
        </div>;
      })}
    </div>
    <div className="jam-row">
      <label>Instrument <select data-testid="jam-instrument" value={`${session.myInstrument.bank}:${session.myInstrument.program}`} onChange={(e) => { const [b, p] = e.target.value.split(":").map(Number); void session.setInstrument(b, p); }}>
        {INSTRUMENTS.map((i) => <option key={i.name} value={`${i.bank}:${i.program}`}>{i.name}</option>)}</select></label>
      <button className="jam-panic" data-testid="jam-panic" onClick={() => session.panic()}>Panic (all notes off)</button>
      <MidiPicker session={session} />
    </div>
    <MetronomePanel session={session} />
    <TakePanel session={session} />
    <JamKeyboard session={session} />
    {host && <div className="jam-row jam-host">
      {invite ? <><input readOnly value={link} aria-label="Invite link" data-testid="jam-invite-link" onFocus={(e) => e.target.select()} /><span>Code <b data-testid="jam-invite-code">{invite.code}</b></span></> : <span>Invite hidden. Make a new one to share.</span>}
      <button onClick={act(async () => setInvite((await jamApi.rotate(roomId, me)).invite))}>New invite</button>
      <button onClick={act(async () => { await jamApi.revoke(roomId, me); setInvite(undefined); })}>Revoke invite</button>
      <button onClick={act(() => jamApi.lock(roomId, me, !snap?.locked))}>{snap?.locked ? "Unlock room" : "Lock room"}</button>
      <button onClick={act(() => jamApi.end(roomId, me))}>End room</button>
    </div>}
    <div className="jam-row"><button data-testid="jam-leave" onClick={act(async () => { await jamApi.leave(roomId, me).catch(() => undefined); sessionStorage.removeItem(storeKey(roomId)); session.teardown(); })}>Leave</button>
      <button onClick={() => setDiag(!diag)} aria-expanded={diag}>Connection details</button></div>
    {diag && <ConnectionDetails session={session} />}
    {err && <p role="alert" className="jam-err">{err}</p>}
  </section>;
}

function MetronomePanel({ session }: { session: JamSession }) {
  const t = session.snapshot?.transport; const host = session.isHost; const m = session.metronome;
  const [bpm, setBpm] = useState(t?.bpm ?? 100); const [meter, setMeter] = useState(t?.beatsPerBar ?? 4); const [countIn, setCountIn] = useState(1); const [, tick] = useState(0);
  useEffect(() => { if (t) { setBpm(t.bpm); setMeter(t.beatsPerBar); } }, [t?.revision]);
  useEffect(() => { const i = setInterval(() => tick((n) => n + 1), 100); return () => clearInterval(i); }, []);
  const pos = m.position(performance.now());
  const send = (running: boolean, b = bpm, bp = meter) => session.setTransport(running, b, bp, countIn);
  return <div className="jam-row jam-metro" data-testid="jam-metronome" data-running={t?.running ? "1" : "0"} data-bpm={t?.bpm ?? ""} data-clicks={m.scheduled}>
    <strong>Metronome</strong>
    {host ? <>
      <button data-testid="jam-metro-toggle" onClick={() => send(!t?.running)}>{t?.running ? "Stop" : "Start"}</button>
      <label>Tempo <input type="number" min={30} max={300} value={bpm} data-testid="jam-metro-bpm" onChange={(e) => setBpm(Number(e.target.value))} onBlur={() => t?.running && bpm >= 30 && bpm <= 300 && send(true)} /></label>
      <label>Beats <select value={meter} onChange={(e) => { const v = Number(e.target.value); setMeter(v); if (t?.running) send(true, bpm, v); }}>{[2, 3, 4, 5, 6, 7].map((n) => <option key={n}>{n}</option>)}</select></label>
      <label>Count-in <select value={countIn} onChange={(e) => setCountIn(Number(e.target.value))}><option value={0}>None</option><option value={1}>1 bar</option><option value={2}>2 bars</option></select></label>
    </> : <span>{t?.running ? `${t.bpm} BPM, ${t.beatsPerBar}/4` : "Off"} (the host controls it)</span>}
    <span data-testid="jam-metro-pos" aria-live="off">{pos ? (pos.countIn ? `Count-in ${pos.beatInBar}` : `Bar ${pos.bar} · ${pos.beatInBar}`) : ""}</span>
    <label><input type="checkbox" checked={m.enabled} onChange={(e) => { m.setEnabled(e.target.checked); tick((n) => n + 1); }} /> Hear clicks</label>
  </div>;
}

function TakePanel({ session }: { session: JamSession }) {
  const tk = session.take; const [, tick] = useState(0); const [msgTxt, setMsg] = useState("");
  useEffect(() => { if (!tk.recording) return; const i = setInterval(() => tick((n) => n + 1), 500); return () => clearInterval(i); }, [tk.recording]);
  const has = !tk.recording && tk.stopMs > 0;
  const download = () => { const p = session.takeProject(); const blob = new Blob([serializeSmf(p) as BlobPart], { type: "audio/midi" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "live-jam-take.mid"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10_000); };
  const openStudio = async () => { const p = session.takeProject(); await midiFileStore.putProject({ id: p.id, schemaVersion: PROJECT_SCHEMA_VERSION, savedAt: Date.now(), project: p }); setMsg("Saved. Open Studio to edit it or export WAV."); navigate("studio"); };
  return <div className="jam-row jam-take" data-testid="jam-take" data-notes={tk.count} data-recording={tk.recording ? "1" : "0"}>
    <strong>Take</strong>
    {tk.recording ? <><span className="jam-rec">● Recording · {tk.count} notes</span><button data-testid="jam-take-stop" onClick={() => session.stopTake()}>Stop take</button></>
      : <button data-testid="jam-take-start" onClick={() => session.startTake()}>Record take</button>}
    {has && <><span>{tk.count} notes</span><button data-testid="jam-take-mid" onClick={download}>Download MIDI</button><button onClick={() => void openStudio()}>Open in Studio</button></>}
    <small>Recorded only on this device. Everyone's playing is captured as their own track.</small>{msgTxt && <small>{msgTxt}</small>}
  </div>;
}

function ConnectionDetails({ session }: { session: JamSession }) {
  const [, tick] = useState(0); useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const c = session.clock;
  return <div className="jam-diag" data-testid="jam-diag"><p>Clock: offset {fmtMs(c.ready ? c.offsetMs : null)}, uncertainty ±{fmtMs(c.ready ? c.uncertaintyMs : null)}, signaling RTT {fmtMs(c.rttMs)}</p>
    <table><thead><tr><th>Player</th><th>Link</th><th>Path</th><th>RTT</th><th>Buffer</th><th>Lost</th><th>Late dropped</th><th>Dupes</th></tr></thead><tbody>
      {[...session.receivers.keys()].map((pid) => { const s = session.peerStats(pid); const name = session.snapshot?.participants.find((p) => p.participantId === pid)?.name ?? pid;
        return <tr key={pid}><td>{name}</td><td>{s.link?.state ?? "unknown"}</td><td>{s.link?.candidateType ? `${s.link.candidateType}/${s.link.protocol}` : "unknown"}</td><td>{fmtMs(s.link?.rttMs)}</td><td>{fmtMs(s.receive?.budgetMs)}</td><td>{s.receive?.gaps ?? 0}</td><td>{s.receive?.lateAttacksDropped ?? 0}</td><td>{s.receive?.duplicates ?? 0}</td></tr>; })}
    </tbody></table><p>Direct connections can show your network address to the other players in the room.</p></div>;
}

function MidiPicker({ session }: { session: JamSession }) {
  const mgr = useMemo(() => new MidiInputManager(navigator as never, (data, _id, ts) => session.router.midi(data, ts)), [session]);
  const status = useSyncExternalStore((f) => mgr.subscribe(f), () => mgr.status);
  useEffect(() => () => mgr.disable(), [mgr]);
  if (!mgr.supported) return null;
  return <span className="jam-midi">{status.kind === "off" ? <button onClick={() => void mgr.enable()}>Use MIDI keyboard</button> : <>
    <select value={mgr.selectedId} onChange={(e) => mgr.select(e.target.value)} aria-label="MIDI input"><option value="all">All MIDI inputs</option>{mgr.devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
    <small>{status.message}</small></>}</span>;
}

const KEYMAP = "awsedftgyhujkolp;'"; // computer keys from C
export function JamKeyboard({ session }: { session: JamSession }) {
  const [octave, setOctave] = useState(4); const [vel, setVel] = useState(96); const down = useRef(new Map<string | number, number>()); const [, force] = useState(0);
  const base = 12 * (octave + 1);
  const on = (key: string | number, note: number, t: number) => { if (down.current.has(key)) return; down.current.set(key, note); session.router.noteOn(note, vel, t); force((n) => n + 1); };
  const off = (key: string | number, t: number) => { const n = down.current.get(key); if (n === undefined) return; down.current.delete(key); session.router.noteOff(n, t); force((x) => x + 1); };
  useEffect(() => {
    const kd = (e: KeyboardEvent) => { if (e.repeat || (e.target as HTMLElement)?.tagName === "INPUT") return; if (e.code === "Space") { e.preventDefault(); session.router.controlChange(64, 127, e.timeStamp); return; }
      const i = KEYMAP.indexOf(e.key.toLowerCase()); if (i >= 0) on(`k${e.key.toLowerCase()}`, base + i, e.timeStamp); if (e.key === "z") setOctave((o) => Math.max(1, o - 1)); if (e.key === "x") setOctave((o) => Math.min(7, o + 1)); };
    const ku = (e: KeyboardEvent) => { if (e.code === "Space") { session.router.controlChange(64, 0, e.timeStamp); return; } off(`k${e.key.toLowerCase()}`, e.timeStamp); };
    const blur = () => { for (const k of [...down.current.keys()]) off(k, performance.now()); };
    window.addEventListener("keydown", kd); window.addEventListener("keyup", ku); window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", kd); window.removeEventListener("keyup", ku); window.removeEventListener("blur", blur); blur(); };
  });
  const keys = Array.from({ length: 25 }, (_, i) => base + i); const black = (n: number) => [1, 3, 6, 8, 10].includes(n % 12);
  const held = new Set(down.current.values());
  return <div className="jam-kb-wrap">
    <div className="jam-row"><button onClick={() => setOctave((o) => Math.max(1, o - 1))} aria-label="Octave down">−</button><span>Octave {octave}</span><button onClick={() => setOctave((o) => Math.min(7, o + 1))} aria-label="Octave up">+</button>
      <label>Velocity <input type="range" min={20} max={127} value={vel} onChange={(e) => setVel(Number(e.target.value))} /></label>
      <button onPointerDown={(e) => session.router.controlChange(64, 127, e.timeStamp)} onPointerUp={(e) => session.router.controlChange(64, 0, e.timeStamp)} onPointerCancel={(e) => session.router.controlChange(64, 0, e.timeStamp)}>Sustain (hold, or Space)</button></div>
    <div className="jam-kb" data-testid="jam-keyboard" style={{ touchAction: "none" }}
      onPointerDown={(e) => { const n = Number((e.target as HTMLElement).dataset.note); if (!Number.isFinite(n)) return; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); on(e.pointerId, n, e.timeStamp); }}
      onPointerMove={(e) => { if (!down.current.has(e.pointerId)) return; const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null; const n = Number(el?.dataset.note); if (Number.isFinite(n) && n !== down.current.get(e.pointerId)) { off(e.pointerId, e.timeStamp); on(e.pointerId, n, e.timeStamp); } }}
      onPointerUp={(e) => off(e.pointerId, e.timeStamp)} onPointerCancel={(e) => off(e.pointerId, e.timeStamp)}>
      {keys.map((n) => <div key={n} data-note={n} className={`jam-key ${black(n) ? "black" : "white"} ${held.has(n) ? "down" : ""}`} role="button" aria-label={`Note ${n}`} />)}
    </div></div>;
}
