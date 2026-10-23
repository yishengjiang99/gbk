import { parseKey } from "../music/keys.ts";
import { barBeatToTick } from "./timing.ts";
import { overridesToNrpn } from "../sf2/voice-overrides.ts";
// Standard MIDI File <-> Project. Lossless for notes, timed CC, bend, pressure, program/bank,
// tempo/meter, and keeps unsupported events (sysex, other meta) as raw bytes for re-export.
import { DEFAULT_MIX, TRACK_COLORS, PROJECT_SCHEMA_VERSION, emptyProject, newId, computeEndTick, type Project, type Track } from "./model.ts";

const u16 = (u: Uint8Array, o: number) => (u[o] << 8) | u[o + 1];
const u32 = (u: Uint8Array, o: number) => ((u[o] << 24) >>> 0) + (u[o + 1] << 16) + (u[o + 2] << 8) + u[o + 3];

/** Strip control chars and clamp length: names/metadata are untrusted. */
export function sanitizeText(s: string, max = 128): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
}

export function parseSmf(buf: ArrayBuffer | Uint8Array, name = "Imported"): Project {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (String.fromCharCode(...u.subarray(0, 4)) !== "MThd") throw new Error("Not a MIDI file");
  const hl = u32(u, 4);
  const format = u16(u, 8), ntrks = u16(u, 10), division = u16(u, 12);
  if (division & 0x8000) throw new Error("SMPTE time division is not supported");
  const p = emptyProject(sanitizeText(name), division);
  p.format = format; p.tempos = []; p.timeSigs = [];
  let pos = 8 + hl;
  for (let ti = 0; ti < ntrks && pos + 8 <= u.length; ti++) {
    if (String.fromCharCode(...u.subarray(pos, pos + 4)) !== "MTrk") throw new Error(`Missing MTrk at track ${ti}`);
    const len = u32(u, pos + 4);
    const end = Math.min(u.length, pos + 8 + len);
    let i = pos + 8;
    const track: Track = { id: newId("trk"), name: `Track ${ti + 1}`, channel: -1, color: TRACK_COLORS[ti % TRACK_COLORS.length], mix: { ...DEFAULT_MIX }, visible: true };
    const bankMsb = new Uint8Array(16), bankLsb = new Uint8Array(16);
    const open = new Map<number, { tick: number; vel: number }[]>();
    let tick = 0, running = 0;
    const vlq = () => { let v = 0, b = 0; do { b = u[i++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80 && i < end); return v; };
    while (i < end) {
      tick += vlq();
      let st = u[i];
      if (st & 0x80) { i++; if (st < 0xf0) running = st; } else st = running;
      if (st === 0xff) {
        const type = u[i++]; const l = vlq(); const data = u.subarray(i, i + l); i += l;
        if (type === 0x2f) break;
        if (type === 0x51 && l === 3) { p.tempos.push({ tick, microPerQuarter: (data[0] << 16) | (data[1] << 8) | data[2] }); continue; }
        if (type === 0x58 && l >= 2) { p.timeSigs.push({ tick, numerator: data[0], denominator: 2 ** data[1] }); continue; }
        if (type === 0x03) { track.name = sanitizeText(new TextDecoder().decode(data)) || track.name; continue; }
        p.raw.push({ id: newId("raw"), trackId: track.id, tick, kind: "meta", bytes: [0xff, type, ...encVlq(l), ...data] });
        continue;
      }
      if (st === 0xf0 || st === 0xf7) {
        const l = vlq(); const data = u.subarray(i, i + l); i += l;
        p.raw.push({ id: newId("raw"), trackId: track.id, tick, kind: "sysex", bytes: [st, ...encVlq(l), ...data] });
        continue;
      }
      const cmd = st & 0xf0, ch = st & 0x0f;
      const d1 = u[i++] & 0x7f;
      const d2 = cmd === 0xc0 || cmd === 0xd0 ? 0 : u[i++] & 0x7f;
      if (track.channel < 0) track.channel = ch;
      const key = ch * 128 + d1;
      if (cmd === 0x90 && d2 > 0) {
        const s = open.get(key) ?? []; s.push({ tick, vel: d2 }); open.set(key, s);
      } else if (cmd === 0x80 || cmd === 0x90) {
        const s = open.get(key); const on = s?.shift();
        if (on) p.notes.push({ id: newId("n"), trackId: track.id, channel: ch, tick: on.tick, duration: Math.max(1, tick - on.tick), pitch: d1, velocity: on.vel, ...(cmd === 0x80 && d2 !== 64 ? { offVelocity: d2 } : {}) });
      } else if (cmd === 0xb0) {
        if (d1 === 0) bankMsb[ch] = d2;
        if (d1 === 32) bankLsb[ch] = d2;
        p.ccs.push({ id: newId("cc"), trackId: track.id, channel: ch, controller: d1, tick, value: d2 });
      } else if (cmd === 0xc0) {
        p.programs.push({ id: newId("pg"), trackId: track.id, channel: ch, tick, program: d1, bankMsb: bankMsb[ch], bankLsb: bankLsb[ch] });
      } else if (cmd === 0xe0) {
        p.pitchBends.push({ id: newId("pb"), trackId: track.id, channel: ch, tick, value: (d2 << 7) | d1 });
      } else if (cmd === 0xd0) {
        p.channelPressure.push({ id: newId("cp"), trackId: track.id, channel: ch, tick, value: d1 });
      } else if (cmd === 0xa0) {
        p.polyPressure.push({ id: newId("pp"), trackId: track.id, channel: ch, tick, pitch: d1, value: d2 });
      }
    }
    // close dangling notes at track end
    for (const [key, s] of open) for (const on of s) p.notes.push({ id: newId("n"), trackId: track.id, channel: key >> 7, tick: on.tick, duration: Math.max(1, tick - on.tick), pitch: key & 127, velocity: on.vel });
    if (track.channel < 0) track.channel = 0;
    p.tracks.push(track);
    pos = pos + 8 + len;
  }
  if (!p.tempos.length || p.tempos[0].tick > 0) p.tempos.unshift({ tick: 0, microPerQuarter: 500000 });
  if (!p.timeSigs.length || p.timeSigs[0].tick > 0) p.timeSigs.unshift({ tick: 0, numerator: 4, denominator: 4 });
  p.notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
  p.endTick = computeEndTick(p);
  p.schemaVersion = PROJECT_SCHEMA_VERSION;
  return p;
}

export function encVlq(v: number): number[] {
  const out = [v & 0x7f];
  while ((v >>= 7) > 0) out.unshift((v & 0x7f) | 0x80);
  return out;
}

interface Ev { tick: number; order: number; seq: number; bytes: number[] }

/** Serialize to SMF format 1. Track 0 = conductor (tempo/meter); then one MTrk per project track. */
/** soundNrpn: also emit the project's additive voice overrides as SF2 NRPNs (9.6) at tick 0 (file export only;
 * the internal player path applies overrides directly and must not receive them twice). */
export function serializeSmf(p: Project, opts: { soundNrpn?: boolean } = {}): Uint8Array {
  const chunks: number[][] = [];
  let seq = 0;
  const conductor: Ev[] = [];
  for (const t of p.tempos) conductor.push({ tick: t.tick, order: 0, seq: seq++, bytes: [0xff, 0x51, 3, (t.microPerQuarter >> 16) & 255, (t.microPerQuarter >> 8) & 255, t.microPerQuarter & 255] });
  for (const t of p.timeSigs) conductor.push({ tick: t.tick, order: 0, seq: seq++, bytes: [0xff, 0x58, 4, t.numerator, Math.round(Math.log2(t.denominator)), 24, 8] });
  // GBK composition metadata: key signature + section markers (FF 06) in the conductor track.
  if (p.meta?.key) { try { const k = parseKey(p.meta.key); conductor.push({ tick: 0, order: 0, seq: seq++, bytes: [0xff, 0x59, 2, k.sf & 0xff, k.mode === "minor" ? 1 : 0] }); } catch { /* free-form key text */ } }
  for (const sec of p.meta?.sections ?? []) {
    const nm = Array.from(new TextEncoder().encode(sec.name));
    conductor.push({ tick: barBeatToTick(p, sec.startBar), order: 0, seq: seq++, bytes: [0xff, 0x06, ...encVlq(nm.length), ...nm] });
  }
  chunks.push(encodeTrack(conductor));
  for (const tr of p.tracks) {
    const evs: Ev[] = [];
    const nameBytes = Array.from(new TextEncoder().encode(tr.name));
    evs.push({ tick: 0, order: -1, seq: seq++, bytes: [0xff, 0x03, ...encVlq(nameBytes.length), ...nameBytes] });
    for (const r of p.raw) if (r.trackId === tr.id) evs.push({ tick: r.tick, order: -1, seq: seq++, bytes: r.bytes });
    for (const c of p.ccs) if (c.trackId === tr.id) evs.push({ tick: c.tick, order: c.controller === 0 || c.controller === 32 ? 0 : 4, seq: seq++, bytes: [0xb0 | c.channel, c.controller, c.value] });
    for (const g of p.programs) if (g.trackId === tr.id) evs.push({ tick: g.tick, order: 1, seq: seq++, bytes: [0xc0 | g.channel, g.program] });
    for (const n of p.notes) if (n.trackId === tr.id) {
      evs.push({ tick: n.tick, order: 3, seq: seq++, bytes: [0x90 | n.channel, n.pitch, n.velocity] });
      evs.push({ tick: n.tick + n.duration, order: 2, seq: seq++, bytes: [0x80 | n.channel, n.pitch, n.offVelocity ?? 64] });
    }
    for (const b of p.pitchBends) if (b.trackId === tr.id) evs.push({ tick: b.tick, order: 5, seq: seq++, bytes: [0xe0 | b.channel, b.value & 0x7f, (b.value >> 7) & 0x7f] });
    for (const c of p.channelPressure) if (c.trackId === tr.id) evs.push({ tick: c.tick, order: 6, seq: seq++, bytes: [0xd0 | c.channel, c.value] });
    for (const c of p.polyPressure) if (c.trackId === tr.id) evs.push({ tick: c.tick, order: 6, seq: seq++, bytes: [0xa0 | c.channel, c.pitch, c.value] });
    const ovr = opts.soundNrpn ? p.sound?.tracks[tr.id] : undefined;
    if (ovr?.length) {
      const chans = new Set([tr.channel, ...p.notes.filter((n) => n.trackId === tr.id).map((n) => n.channel)]);
      for (const ch of chans) for (const b of overridesToNrpn(ovr, ch).bytes) evs.push({ tick: 0, order: 1.5, seq: seq++, bytes: b });
    }
    chunks.push(encodeTrack(evs));
  }
  const out: number[] = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, (chunks.length >> 8) & 255, chunks.length & 255, (p.ppq >> 8) & 255, p.ppq & 255];
  for (const c of chunks) out.push(0x4d, 0x54, 0x72, 0x6b, (c.length >>> 24) & 255, (c.length >> 16) & 255, (c.length >> 8) & 255, c.length & 255, ...c);
  return new Uint8Array(out);
}

function encodeTrack(evs: Ev[]): number[] {
  evs.sort((a, b) => a.tick - b.tick || a.order - b.order || a.seq - b.seq);
  const out: number[] = [];
  let last = 0;
  for (const e of evs) { out.push(...encVlq(e.tick - last), ...e.bytes); last = e.tick; }
  out.push(0, 0xff, 0x2f, 0);
  return out;
}
