// Full-mesh WebRTC data-only peers. One RTCPeerConnection per remote participant, two pre-negotiated channels:
//   jam.events.v1  id 0, unordered, maxRetransmits 0   (live events, heartbeats/snapshots)
//   jam.control.v1 id 1, reliable ordered               (hello/instrument/probes)
// Roles are deterministic: the lower participantId offers; the other side only answers (no glare, no rollback,
// same rules on every platform). ICE restarts are always initiated by the offerer; the answerer asks with "restart".
// No media tracks, no getUserMedia.
import type { RoomSnapshot } from "../../shared/jam/signaling.ts";
import type { ServerFrame, ClientFrame } from "../../shared/jam/signaling.ts";
import { decodeControl, type ControlMessage } from "../../shared/jam/events.ts";

export const EVENTS_CHANNEL = "jam.events.v1";
export const CONTROL_CHANNEL = "jam.control.v1";
export const MAX_EARLY_CANDIDATES = 64;
export const EVENTS_BUFFER_LIMIT = 64 * 1024;
export const RELEASE_BUFFER_LIMIT = 256 * 1024;
export type LinkState = "connecting" | "ready" | "degraded" | "reconnecting" | "closed";

type SignalOut = Extract<ClientFrame, { type: "signal" }>;
type SignalIn = Extract<ServerFrame, { type: "signal" }>;
export interface PeerLinkStats { state: LinkState; rttMs: number | null; candidateType: string | null; protocol: string | null; relay: boolean | null; restarts: number; sendDrops: number; eventsMaxRetransmits: number | null; eventsOrdered: boolean | null; bytesSent: number | null; bytesReceived: number | null }

export interface PeerManagerDeps {
  selfId: () => string; selfGeneration: () => number; epoch: () => number;
  signal(f: SignalOut): void;
  ice(): Promise<{ iceServers: RTCIceServer[]; iceTransportPolicy: RTCIceTransportPolicy }>;
  onEvents(pid: string, bytes: Uint8Array): void;
  onControl(pid: string, m: ControlMessage): void;
  onLinkState(pid: string, s: LinkState): void;
  createPc?: (cfg: RTCConfiguration) => RTCPeerConnection;
}

class Peer {
  pc: RTCPeerConnection; events: RTCDataChannel; control: RTCDataChannel;
  early: RTCIceCandidateInit[] = []; revision = 0; restarts = 0; sendDrops = 0; state: LinkState = "connecting";
  failTimer: ReturnType<typeof setTimeout> | null = null; stats: PeerLinkStats;
  constructor(public pid: string, public generation: number, public initiator: boolean, cfg: RTCConfiguration, create: (c: RTCConfiguration) => RTCPeerConnection) {
    this.pc = create(cfg);
    this.events = this.pc.createDataChannel(EVENTS_CHANNEL, { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    this.control = this.pc.createDataChannel(CONTROL_CHANNEL, { negotiated: true, id: 1, ordered: true });
    this.events.binaryType = "arraybuffer";
    this.stats = { state: "connecting", rttMs: null, candidateType: null, protocol: null, relay: null, restarts: 0, sendDrops: 0, eventsMaxRetransmits: null, eventsOrdered: null, bytesSent: null, bytesReceived: null };
  }
}

export class PeerManager {
  private peers = new Map<string, Peer>();
  /** Signals that arrive before we know the peer (our snapshot or ICE config is still in flight). Bounded. */
  private pending = new Map<string, SignalIn[]>();
  private creating = new Set<string>();
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  constructor(private d: PeerManagerDeps) {}
  get ids() { return [...this.peers.keys()]; }
  stats(pid: string): PeerLinkStats | null { return this.peers.get(pid)?.stats ?? null; }

  /** Reconcile peers with the room snapshot: create for new/regenerated connected members, close the rest. */
  async update(s: RoomSnapshot) {
    const self = this.d.selfId(); const want = new Map(s.participants.filter((p) => p.participantId !== self && p.connected).map((p) => [p.participantId, p.generation]));
    for (const [pid, peer] of this.peers) if (!want.has(pid) || want.get(pid) !== peer.generation) this.close(pid);
    for (const [pid, gen] of want) if (!this.peers.has(pid)) await this.create(pid, gen);
    if (!this.statsTimer && this.peers.size) { this.statsTimer = setInterval(() => void this.pollStats(), 2000); }
  }
  private async create(pid: string, generation: number) {
    if (this.creating.has(pid)) return; this.creating.add(pid);
    let ice: Awaited<ReturnType<PeerManagerDeps["ice"]>>;
    try { ice = await this.d.ice(); } finally { this.creating.delete(pid); }
    if (this.peers.has(pid)) return;
    const peer = new Peer(pid, generation, this.d.selfId() < pid, { iceServers: ice.iceServers, iceTransportPolicy: ice.iceTransportPolicy }, this.d.createPc ?? ((c) => new RTCPeerConnection(c)));
    this.peers.set(pid, peer);
    const { pc } = peer;
    pc.onicecandidate = (e) => this.sig(peer, e.candidate ? { kind: "candidate", candidate: { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex } } : { kind: "end-of-candidates" });
    pc.onconnectionstatechange = () => this.onConn(peer);
    peer.events.onmessage = (e) => { if (e.data instanceof ArrayBuffer) this.d.onEvents(pid, new Uint8Array(e.data)); };
    peer.control.onmessage = (e) => { const m = typeof e.data === "string" ? decodeControl(e.data) : null; if (m) this.d.onControl(pid, m); };
    const opened = () => { if (peer.events.readyState === "open" && peer.control.readyState === "open") this.setState(peer, "ready"); };
    peer.events.onopen = opened; peer.control.onopen = opened;
    // Watchdog: a link that is not up after 8 s gets an ICE restart (covers lost offers/answers).
    const watch = () => { if (this.peers.get(pid) !== peer) return; if (peer.state !== "ready") { void this.restart(peer); setTimeout(watch, 8000); } };
    setTimeout(watch, 8000);
    if (peer.initiator) await this.offer(peer, false);
    const early = this.pending.get(pid) ?? []; this.pending.delete(pid);
    for (const f of early) if (f.fromGeneration === generation) await this.onSignal(f);
  }
  private sig(peer: Peer, f: Pick<SignalOut, "kind" | "sdp" | "candidate">) { this.d.signal({ type: "signal", to: peer.pid, toGeneration: peer.generation, epoch: this.d.epoch(), revision: peer.revision, ...f }); }
  private async offer(peer: Peer, iceRestart: boolean) {
    if (peer.pc.signalingState !== "stable") return;
    peer.revision++;
    const o = await peer.pc.createOffer({ iceRestart }); await peer.pc.setLocalDescription(o);
    this.sig(peer, { kind: "offer", sdp: peer.pc.localDescription!.sdp });
  }
  async onSignal(f: SignalIn) {
    const peer = this.peers.get(f.from);
    if (!peer || f.fromGeneration > peer.generation) { // not created yet, or our snapshot is behind: keep for later
      const q = this.pending.get(f.from) ?? []; if (q.length < MAX_EARLY_CANDIDATES) q.push(f); this.pending.set(f.from, q); return;
    }
    if (f.fromGeneration !== peer.generation) return; // stale generation
    const pc = peer.pc;
    try {
      if (f.kind === "offer" && !peer.initiator && f.sdp) {
        peer.revision = f.revision;
        await pc.setRemoteDescription({ type: "offer", sdp: f.sdp });
        for (const c of peer.early.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
        const a = await pc.createAnswer(); await pc.setLocalDescription(a);
        this.sig(peer, { kind: "answer", sdp: pc.localDescription!.sdp });
      } else if (f.kind === "answer" && peer.initiator && f.sdp) {
        if (pc.signalingState !== "have-local-offer" || f.revision !== peer.revision) return; // late/duplicate answer
        await pc.setRemoteDescription({ type: "answer", sdp: f.sdp });
        for (const c of peer.early.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
      } else if (f.kind === "candidate" && f.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(f.candidate).catch(() => undefined);
        else if (peer.early.length < MAX_EARLY_CANDIDATES) peer.early.push(f.candidate);
      } else if (f.kind === "restart" && peer.initiator) await this.restart(peer);
    } catch { /* a failed negotiation step recovers through the connection-state watchdog */ }
  }
  private onConn(peer: Peer) {
    const s = peer.pc.connectionState;
    if (s === "connected") { if (peer.failTimer) clearTimeout(peer.failTimer); peer.failTimer = null; if (peer.events.readyState === "open") this.setState(peer, "ready"); return; }
    if (s === "disconnected" || s === "failed") {
      this.setState(peer, "reconnecting");
      if (!peer.failTimer) peer.failTimer = setTimeout(() => { peer.failTimer = null; if (peer.pc.connectionState !== "connected") void this.restart(peer); }, s === "failed" ? 0 : 3000);
    }
  }
  /** ICE restart without rebuilding the room; after 3 tries the link is rebuilt. */
  async restart(peer: Peer) {
    if (!this.peers.has(peer.pid)) return;
    peer.restarts++; peer.stats.restarts = peer.restarts;
    if (!peer.initiator) { this.sig(peer, { kind: "restart" }); return; }
    if (peer.restarts > 3) { const { pid, generation } = peer; this.close(pid); await this.create(pid, generation); return; }
    await this.offer(peer, true).catch(() => undefined);
  }
  private setState(peer: Peer, s: LinkState) { if (peer.state === s) return; peer.state = s; peer.stats.state = s; this.d.onLinkState(peer.pid, s); }
  /** Event channel send with backpressure: attacks drop when buffered, releases get more room. */
  sendEvents(pid: string, bytes: Uint8Array, critical: boolean): boolean {
    const p = this.peers.get(pid); if (!p || p.events.readyState !== "open") return false;
    if (p.events.bufferedAmount > (critical ? RELEASE_BUFFER_LIMIT : EVENTS_BUFFER_LIMIT)) { p.sendDrops++; p.stats.sendDrops = p.sendDrops; return false; }
    p.events.send(bytes as Uint8Array<ArrayBuffer>); return true;
  }
  sendControl(pid: string, m: ControlMessage) { const p = this.peers.get(pid); if (p && p.control.readyState === "open") p.control.send(JSON.stringify(m)); }
  isOpen(pid: string) { return this.peers.get(pid)?.events.readyState === "open"; }
  close(pid: string) { const p = this.peers.get(pid); if (!p) return; this.pending.delete(pid); this.peers.delete(pid); if (p.failTimer) clearTimeout(p.failTimer); try { p.events.close(); p.control.close(); p.pc.close(); } catch { /* closed */ } this.d.onLinkState(pid, "closed"); }
  closeAll() { for (const pid of [...this.peers.keys()]) this.close(pid); if (this.statsTimer) clearInterval(this.statsTimer); this.statsTimer = null; }
  private async pollStats() {
    for (const p of this.peers.values()) {
      try {
        const r = await p.pc.getStats(); let pairId: string | null = null; const byId = new Map<string, Record<string, unknown>>();
        r.forEach((v: Record<string, unknown>) => { byId.set(v.id as string, v); if (v.type === "transport" && v.selectedCandidatePairId) pairId = v.selectedCandidatePairId as string; });
        if (!pairId) r.forEach((v: Record<string, unknown>) => { if (v.type === "candidate-pair" && (v.selected || (v.nominated && v.state === "succeeded"))) pairId = v.id as string; });
        const pair = pairId ? byId.get(pairId) : undefined; const local = pair ? byId.get(pair.localCandidateId as string) : undefined;
        p.stats.rttMs = typeof pair?.currentRoundTripTime === "number" ? pair.currentRoundTripTime * 1000 : null;
        p.stats.candidateType = (local?.candidateType as string) ?? null; p.stats.protocol = (local?.protocol as string) ?? null;
        p.stats.relay = local ? local.candidateType === "relay" : null;
        p.stats.bytesSent = typeof pair?.bytesSent === "number" ? pair.bytesSent : null; p.stats.bytesReceived = typeof pair?.bytesReceived === "number" ? pair.bytesReceived : null;
        p.stats.eventsMaxRetransmits = p.events.maxRetransmits; p.stats.eventsOrdered = p.events.ordered;
      } catch { /* closed */ }
    }
  }
}
