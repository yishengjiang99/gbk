// Live Jam session controller: the one owner of signaling, peer links, clock, input routing, receive schedulers,
// audio engines and timers. Every dependency is injected, so the whole flow runs in unit tests with fakes.
import type { RoomSnapshot, ServerFrame, ClientFrame, PeerState } from "../../shared/jam/signaling.ts";
import { decodePacket, encodePacket, Kind, type ControlMessage, type JamEvent } from "../../shared/jam/events.ts";
import { ClockEstimator } from "./clock.ts";
import { InputRouter } from "./input-router.ts";
import { ReceiveScheduler, type SchedulerOptions } from "./receive-scheduler.ts";
import type { JamAudioOut } from "./audio.ts";
import type { LinkState, PeerLinkStats } from "./peer-manager.ts";
import type { SignalingState } from "./signaling-client.ts";
import { CLICK_PID, Metronome } from "./metronome.ts";
import { TakeRecorder } from "./take.ts";

export interface SignalingLike { state: SignalingState; start(): void; stop(): void; send(f: ClientFrame): void; onFrame: (f: ServerFrame) => void; onState: (s: SignalingState) => void; onClockSample: (s: { t0: number; ts: number; t3: number }) => void }
export interface PeerCallbacks { onEvents(pid: string, bytes: Uint8Array): void; onControl(pid: string, m: ControlMessage): void; onLinkState(pid: string, s: LinkState): void; signal(f: Extract<ClientFrame, { type: "signal" }>): void; selfId(): string; selfGeneration(): number; epoch(): number }
export interface PeerLinksLike { update(s: RoomSnapshot): Promise<void> | void; onSignal(f: Extract<ServerFrame, { type: "signal" }>): Promise<void> | void; sendEvents(pid: string, b: Uint8Array, critical: boolean): boolean; sendControl(pid: string, m: ControlMessage): void; isOpen(pid: string): boolean; stats(pid: string): PeerLinkStats | null; closeAll(): void }
export interface SessionDeps {
  roomId: string; participantId: string;
  signaling: SignalingLike; makePeers(cb: PeerCallbacks): PeerLinksLike; audio: JamAudioOut;
  now(): number; every(f: () => void, ms: number): () => void;
  scheduler?: SchedulerOptions;
}
export type SessionPhase = "connecting" | "ready" | "reconnecting" | "suspended" | "kicked" | "ended" | "left";
export interface Instrument { bank: number; program: number; name: string; revision: number }

export class JamSession {
  phase: SessionPhase = "connecting"; snapshot: RoomSnapshot | null = null; generation = 0;
  readonly clock = new ClockEstimator();
  readonly router: InputRouter;
  readonly receivers = new Map<string, ReceiveScheduler>();
  readonly links = new Map<string, LinkState>();
  readonly instruments = new Map<string, Instrument>();
  readonly mix = new Map<string, { volume: number; muted: boolean }>();
  myInstrument: Instrument = { bank: 0, program: 0, name: "", revision: 0 };
  readonly metronome: Metronome;
  readonly take = new TakeRecorder();
  received = new Map<string, number>(); // note-ons received per peer (diagnostics/tests)
  private peers: PeerLinksLike; private stops: (() => void)[] = []; private listeners = new Set<() => void>(); private torn = false; private serverEpoch = "";
  constructor(private d: SessionDeps) {
    const me = d.participantId;
    this.router = new InputRouter({
      monitor: (e) => d.audio.post(me, null, e),
      send: (e, red) => { this.take.add(me, e); this.broadcast(e, red); },
      localToRoomMs: (t) => this.clock.localToRoom(t), clockRevision: () => this.clock.revision, generation: () => this.generation, instrumentRevision: () => this.myInstrument.revision,
    });
    this.metronome = new Metronome({ roomToLocal: (t) => this.clock.roomToLocal(t), localToRoom: (t) => this.clock.localToRoom(t), post: (t, e) => d.audio.post(CLICK_PID, t, e), clear: () => d.audio.clear(CLICK_PID), now: d.now });
    this.peers = d.makePeers({
      onEvents: (pid, b) => this.onEvents(pid, b), onControl: (pid, m) => this.onControl(pid, m), onLinkState: (pid, s) => this.onLink(pid, s),
      signal: (f) => d.signaling.send(f), selfId: () => me, selfGeneration: () => this.generation, epoch: () => this.snapshot?.epoch ?? 1,
    });
    d.signaling.onFrame = (f) => this.onFrame(f);
    d.signaling.onState = (s) => { if (s === "reconnecting") this.setPhase("reconnecting"); if (s === "suspended") { this.setPhase("suspended"); this.releaseRemote(); } this.emit(); };
    d.signaling.onClockSample = (s) => { this.clock.add(s); };
  }
  subscribe(f: () => void) { this.listeners.add(f); return () => { this.listeners.delete(f); }; }
  private emit() { for (const l of this.listeners) l(); }
  private setPhase(p: SessionPhase) { if (this.phase === "kicked" || this.phase === "ended" || this.phase === "left") return; this.phase = p; }

  start() {
    this.d.audio.ensure(this.d.participantId); this.d.audio.ensure(CLICK_PID); void this.d.audio.setInstrument(CLICK_PID, 128, 0);
    this.d.signaling.start();
    this.stops.push(this.d.every(() => this.heartbeat(), 250));
    this.stops.push(this.d.every(() => { if (this.clock.ready) this.metronome.tick(); }, 50));
    this.stops.push(this.d.every(() => { for (const r of this.receivers.values()) r.checkLease(); }, 100));
  }
  get selfId() { return this.d.participantId; }
  get isHost() { return this.snapshot?.hostId === this.d.participantId; }

  private onFrame(f: ServerFrame) {
    switch (f.type) {
      case "welcome":
        if (this.serverEpoch && f.snapshot.serverEpoch !== this.serverEpoch) this.clock.rebase();
        this.serverEpoch = f.snapshot.serverEpoch; this.generation = f.generation; this.setPhase("ready");
        this.d.signaling.send({ type: "state", state: "preparing", instrumentRevision: this.myInstrument.revision });
        return this.applySnapshot(f.snapshot);
      case "snapshot": return this.applySnapshot(f.snapshot);
      case "signal": void this.peers.onSignal(f); return;
      case "peer-left": this.dropPeer(f.participantId); this.emit(); return;
      case "kicked": this.phase = "kicked"; this.teardown(); return;
      case "ended": this.phase = "ended"; this.teardown(); return;
      case "error": if (f.code === "NOT_MEMBER" || f.code === "REPLACED") { this.phase = f.code === "REPLACED" ? "left" : "kicked"; this.teardown(); } return;
      default: return;
    }
  }
  private applySnapshot(s: RoomSnapshot) {
    this.snapshot = s; if (s.transport) this.metronome.setTransport(s.transport);
    const present = new Set(s.participants.map((p) => p.participantId));
    for (const pid of [...this.receivers.keys()]) if (!present.has(pid)) this.dropPeer(pid);
    for (const p of s.participants) if (p.participantId !== this.d.participantId) {
      let r = this.receivers.get(p.participantId);
      if (!r) { r = new ReceiveScheduler({ schedule: (t, e) => this.d.audio.post(p.participantId, t, e), clear: () => this.d.audio.clear(p.participantId) }, (room) => this.clock.roomToLocal(room), this.d.now, this.d.scheduler); this.receivers.set(p.participantId, r); this.d.audio.ensure(p.participantId); }
      r.setGeneration(p.generation);
    }
    void this.peers.update(s);
    this.emit();
  }
  private dropPeer(pid: string) { const r = this.receivers.get(pid); if (r) { r.releaseAll(); this.receivers.delete(pid); } this.d.audio.remove(pid); this.links.delete(pid); this.instruments.delete(pid); }
  private releaseRemote() { for (const r of this.receivers.values()) r.releaseAll(); }

  private onLink(pid: string, s: LinkState) {
    this.links.set(pid, s);
    if (s === "ready") {
      this.peers.sendControl(pid, { t: "hello", v: 1, capabilities: ["events.v1"] });
      if (this.myInstrument.name) this.peers.sendControl(pid, { t: "instrument", revision: this.myInstrument.revision, soundfont: "default", bank: this.myInstrument.bank, program: this.myInstrument.program, name: this.myInstrument.name });
    }
    const allReady = [...this.receivers.keys()].every((p) => this.links.get(p) === "ready");
    this.d.signaling.send({ type: "state", state: (allReady ? "ready" : "connecting") as PeerState, instrumentRevision: this.myInstrument.revision });
    this.emit();
  }
  private onEvents(pid: string, bytes: Uint8Array) {
    const r = this.receivers.get(pid); if (!r) return;
    const p = decodePacket(bytes); if (!p.ok) { r.stats.malformed++; return; }
    for (const e of p.events) this.take.add(pid, e);
    r.receive(p.events);
    this.received.set(pid, r.stats.attacks);
  }
  private onControl(pid: string, m: ControlMessage) {
    if (m.t === "instrument" && Number.isInteger(m.bank) && Number.isInteger(m.program) && m.program >= 0 && m.program < 128 && m.bank >= 0 && m.bank <= 128) {
      const cur = this.instruments.get(pid); if (cur && cur.revision >= m.revision) return;
      this.instruments.set(pid, { bank: m.bank, program: m.program, name: String(m.name).slice(0, 60), revision: m.revision });
      void this.d.audio.setInstrument(pid, m.bank, m.program); this.emit();
    }
  }
  private broadcast(e: JamEvent, redundant: JamEvent[]) {
    const bytes = encodePacket(e, redundant); const critical = e.kind === Kind.NOTE_OFF || e.kind === Kind.PANIC || (e.kind === Kind.CC && (e.a === 64 || e.a === 66 || e.a >= 120));
    for (const pid of this.receivers.keys()) this.peers.sendEvents(pid, bytes, critical);
  }
  private heartbeat() { if (this.receivers.size) this.broadcast(this.router.snapshot(this.d.now()), []); }

  async setInstrument(bank: number, program: number) {
    const name = await this.d.audio.setInstrument(this.d.participantId, bank, program);
    this.myInstrument = { bank, program, name: name || `Program ${program}`, revision: this.myInstrument.revision + 1 };
    for (const pid of this.receivers.keys()) this.peers.sendControl(pid, { t: "instrument", revision: this.myInstrument.revision, soundfont: "default", bank, program, name: this.myInstrument.name });
    this.emit();
  }
  /** Host only (the server enforces it). Changes start at a future beat on every client. */
  setTransport(running: boolean, bpm: number, beatsPerBar: number, countInBars: number) { this.d.signaling.send({ type: "transport", running, bpm, beatsPerBar, countInBars }); }
  startTake() { this.take.start(this.clock.localToRoom(this.d.now()), this.snapshot?.transport ?? null); this.emit(); }
  stopTake() { this.take.stop(this.clock.localToRoom(this.d.now())); this.emit(); }
  takeProject() {
    const names = new Map((this.snapshot?.participants ?? []).map((p) => [p.participantId, p.name]));
    const players = new Map<string, { name: string; bank: number; program: number }>();
    for (const [pid, name] of names) { const i = pid === this.selfId ? this.myInstrument : this.instruments.get(pid); players.set(pid, { name, bank: i?.bank ?? 0, program: i?.program ?? 0 }); }
    return this.take.toProject(players);
  }
  setMix(pid: string, volume: number, muted: boolean) { this.mix.set(pid, { volume, muted }); this.d.audio.setGain(pid, muted ? 0 : volume); this.emit(); }
  /** Local panic: my notes off everywhere, every engine here silenced. */
  panic() { this.router.panic(this.d.now()); this.d.audio.panic(); for (const r of this.receivers.values()) r.releaseAll(); }
  peerStats(pid: string) { return { link: this.peers.stats(pid), receive: this.receivers.get(pid)?.snapshotStats() ?? null }; }

  /** Stop everything exactly once. */
  teardown() {
    if (this.torn) return; this.torn = true;
    for (const s of this.stops) s(); this.stops = [];
    this.d.signaling.stop(); this.peers.closeAll(); this.d.audio.panic(); this.d.audio.remove(CLICK_PID);
    if (this.phase !== "kicked" && this.phase !== "ended") this.phase = "left";
    this.emit();
  }
}
