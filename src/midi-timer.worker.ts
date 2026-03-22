interface ParsedTempoEvent {
  seq: number;
  tick: number;
  type: "tempo";
  microPerQuarter: number;
}

interface ParsedTimeSigEvent {
  seq: number;
  tick: number;
  type: "timeSig";
  numerator: number;
  denominator: number;
}

interface ParsedNoteOnEvent {
  seq: number;
  tick: number;
  type: "noteOn";
  note: number;
  velocity: number;
  channel: number;
}

interface ParsedNoteOffEvent {
  seq: number;
  tick: number;
  type: "noteOff";
  note: number;
  channel: number;
}

interface ParsedCCEvent {
  seq: number;
  tick: number;
  type: "cc";
  cc: number;
  value: number;
  channel: number;
}

interface ParsedProgramEvent {
  seq: number;
  tick: number;
  type: "program";
  program: number;
  channel: number;
}

type ParsedTrackEvent =
  | ParsedTempoEvent
  | ParsedTimeSigEvent
  | ParsedNoteOnEvent
  | ParsedNoteOffEvent
  | ParsedCCEvent
  | ParsedProgramEvent;

interface TempoSegment {
  tick: number;
  startSec: number;
  microPerQuarter: number;
}

interface PlayNoteOnEvent {
  sec: number;
  type: "noteOn";
  channel: number;
  note: number;
  velocity: number;
  seq: number;
}

interface PlayNoteOffEvent {
  sec: number;
  type: "noteOff";
  channel: number;
  note: number;
  seq: number;
}

interface PlayProgramEvent {
  sec: number;
  type: "program";
  channel: number;
  program: number;
  bank: number;
  seq: number;
}

export type PlayEvent = PlayNoteOnEvent | PlayNoteOffEvent | PlayProgramEvent;

export interface NoteRecord {
  note: number;
  velocity: number;
  channel: number;
  startSec: number;
  durationSec: number;
}

interface ActiveNote {
  startSec: number;
  velocity: number;
  note: number;
  channel: number;
}

interface ParsedTrack {
  trackName: string;
  instrumentName: string;
  events: ParsedTrackEvent[];
}

export interface SongTrack {
  index: number;
  name: string;
  instrumentName: string;
  notes: NoteRecord[];
  playEvents: PlayEvent[];
}

export interface Song {
  format: number;
  division: number;
  durationSec: number;
  tracks: SongTrack[];
  totalBars: number;
  bpm: number;
  timeSig: string;
}

interface WorkerTrackState {
  nextEventIndex: number;
  active: Set<string>;
  override: boolean;
  presetIndex: number | null;
  port: MessagePort | null;
}

interface LoadMidiMsg {
  type: "loadMidi";
  midiData: ArrayBuffer;
}

interface AttachPortsMsg {
  type: "attachPorts";
  ports?: Array<{ trackIndex: number; port: MessagePort }>;
}

interface SetTrackPresetMsg {
  type: "setTrackPreset";
  trackIndex: number;
  regions?: unknown[];
  override?: boolean;
  presetIndex?: number | null;
}

interface PlayMsg {
  type: "play";
  startSec?: number;
}

interface PauseMsg {
  type: "pause";
}

interface SeekMsg {
  type: "seek";
  sec?: number;
}

type InboundMsg = LoadMidiMsg | AttachPortsMsg | SetTrackPresetMsg | PlayMsg | PauseMsg | SeekMsg;

interface WorkerGlobalCtx {
  postMessage(data: unknown): void;
  onmessage: ((event: MessageEvent<InboundMsg>) => void) | null;
}

// `self` in a Web Worker is `DedicatedWorkerGlobalScope`, which uses the broader Window-scope
// DOM lib types that aren't directly assignable to our narrower typed interface. The double
// assertion is needed to bridge the incompatible `onmessage` overload signatures.
// Falls back to a no-op stub when running in plain Node.js (e.g. during tests).
const workerGlobal: WorkerGlobalCtx = typeof self !== "undefined"
  ? (self as unknown as WorkerGlobalCtx)
  : { postMessage: () => undefined, onmessage: null };

function readVarLen(u8: Uint8Array, posRef: { pos: number }): number {
  let v = 0;
  for (let i = 0; i < 4; i += 1) {
    const b = u8[posRef.pos++];
    v = (v << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) break;
  }
  return v >>> 0;
}

function u16be(u8: Uint8Array, p: number): number {
  return (u8[p] << 8) | u8[p + 1];
}

function u32be(u8: Uint8Array, p: number): number {
  return ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
}

function ascii(u8: Uint8Array, start: number, len: number): string {
  return new TextDecoder("ascii").decode(u8.subarray(start, start + len));
}

function parseTrackBytes(trackU8: Uint8Array): ParsedTrack {
  const events: ParsedTrackEvent[] = [];
  let trackName = "";
  let instrumentName = "";
  const posRef = { pos: 0 };
  let tick = 0;
  let runningStatus = 0;
  let seq = 0;

  while (posRef.pos < trackU8.length) {
    const delta = readVarLen(trackU8, posRef);
    tick += delta;
    if (posRef.pos >= trackU8.length) break;

    let status = trackU8[posRef.pos++];
    if (status < 0x80) {
      posRef.pos -= 1;
      status = runningStatus;
    } else {
      runningStatus = status;
    }

    if (status === 0xff) {
      const metaType = trackU8[posRef.pos++] ?? 0;
      const len = readVarLen(trackU8, posRef);
      const dataStart = posRef.pos;
      posRef.pos += len;
      if (metaType === 0x2f) break;
      if (metaType === 0x03 && len > 0) trackName = ascii(trackU8, dataStart, len).replace(/\0/g, "");
      if (metaType === 0x04 && len > 0) instrumentName = ascii(trackU8, dataStart, len).replace(/\0/g, "");
      if (metaType === 0x51 && len === 3) {
        const microPerQuarter =
          (trackU8[dataStart] << 16) | (trackU8[dataStart + 1] << 8) | trackU8[dataStart + 2];
        events.push({ seq: seq++, tick, type: "tempo", microPerQuarter });
      }
      if (metaType === 0x58 && len >= 2) {
        const numerator = trackU8[dataStart] || 4;
        const denominator = 2 ** (trackU8[dataStart + 1] || 2);
        events.push({ seq: seq++, tick, type: "timeSig", numerator, denominator });
      }
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      const len = readVarLen(trackU8, posRef);
      posRef.pos += len;
      continue;
    }

    const cmd = status & 0xf0;
    const channel = status & 0x0f;
    const d1 = trackU8[posRef.pos++] ?? 0;
    let d2 = 0;
    if (cmd !== 0xc0 && cmd !== 0xd0) d2 = trackU8[posRef.pos++] ?? 0;

    if (cmd === 0x90 && d2 > 0) {
      events.push({ seq: seq++, tick, type: "noteOn", note: d1 & 0x7f, velocity: d2 & 0x7f, channel });
    } else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) {
      events.push({ seq: seq++, tick, type: "noteOff", note: d1 & 0x7f, channel });
    } else if (cmd === 0xb0) {
      events.push({ seq: seq++, tick, type: "cc", cc: d1 & 0x7f, value: d2 & 0x7f, channel });
    } else if (cmd === 0xc0) {
      events.push({ seq: seq++, tick, type: "program", program: d1 & 0x7f, channel });
    }
  }

  return { trackName, instrumentName, events };
}

function buildTempoMap(allEvents: ParsedTrackEvent[], division: number): TempoSegment[] {
  const tempos = allEvents
    .filter((e): e is ParsedTempoEvent => e.type === "tempo")
    .map((e) => ({ tick: e.tick, microPerQuarter: e.microPerQuarter }))
    .sort((a, b) => a.tick - b.tick);
  if (!tempos.length || tempos[0].tick !== 0) tempos.unshift({ tick: 0, microPerQuarter: 500000 });
  const compact: Array<{ tick: number; microPerQuarter: number }> = [];
  for (const t of tempos) {
    if (compact.length && compact[compact.length - 1].tick === t.tick) compact[compact.length - 1] = t;
    else compact.push(t);
  }
  const segments: TempoSegment[] = [];
  let startSec = 0;
  for (let i = 0; i < compact.length; i += 1) {
    const cur = compact[i];
    const next = compact[i + 1];
    segments.push({ tick: cur.tick, startSec, microPerQuarter: cur.microPerQuarter });
    if (next) {
      const dticks = next.tick - cur.tick;
      startSec += (dticks * cur.microPerQuarter) / 1000000 / division;
    }
  }
  return segments;
}

function tickToSec(segments: TempoSegment[], division: number, tick: number): number {
  let seg = segments[0];
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i].tick > tick) break;
    seg = segments[i];
  }
  return seg.startSec + ((tick - seg.tick) * seg.microPerQuarter) / 1000000 / division;
}

export function parseMidiBuffer(buffer: ArrayBuffer): Song {
  const u8 = new Uint8Array(buffer);
  if (ascii(u8, 0, 4) !== "MThd") throw new Error("Invalid MIDI header");
  const headerLen = u32be(u8, 4);
  const format = u16be(u8, 8);
  const ntrks = u16be(u8, 10);
  const division = u16be(u8, 12);
  if (division & 0x8000) throw new Error("SMPTE time division is not supported");

  let pos = 8 + headerLen;
  const parsedTracks: ParsedTrack[] = [];
  for (let i = 0; i < ntrks; i += 1) {
    const id = ascii(u8, pos, 4);
    if (id !== "MTrk") throw new Error(`Missing MTrk at track ${i}`);
    const len = u32be(u8, pos + 4);
    const start = pos + 8;
    const trackBytes = u8.subarray(start, start + len);
    parsedTracks.push(parseTrackBytes(trackBytes));
    pos = start + len;
  }

  const allEvents = parsedTracks.flatMap((t) => t.events);
  const tempoMap = buildTempoMap(allEvents, division);
  let maxTick = 0;

  const tracks: SongTrack[] = parsedTracks.map((track, idx) => {
    const notes: NoteRecord[] = [];
    const playEvents: PlayEvent[] = [];
    const active = new Map<string, ActiveNote[]>();
    const bankMsb = new Uint8Array(16);
    const bankLsb = new Uint8Array(16);
    const sorted = [...track.events].sort((a, b) => (a.tick - b.tick) || (a.seq - b.seq));

    for (const e of sorted) {
      const sec = tickToSec(tempoMap, division, e.tick);
      maxTick = Math.max(maxTick, e.tick);
      if (e.type === "cc") {
        if (e.cc === 0) bankMsb[e.channel] = e.value;
        if (e.cc === 32) bankLsb[e.channel] = e.value;
        continue;
      }
      if (e.type === "program") {
        const bank = ((bankMsb[e.channel] & 0x7f) << 7) | (bankLsb[e.channel] & 0x7f);
        playEvents.push({ sec, type: "program", channel: e.channel, program: e.program, bank, seq: e.seq });
        continue;
      }
      if (e.type === "noteOn") {
        const key = `${e.channel}:${e.note}`;
        const stack = active.get(key) ?? [];
        stack.push({ startSec: sec, velocity: e.velocity, note: e.note, channel: e.channel });
        active.set(key, stack);
        playEvents.push({
          sec,
          type: "noteOn",
          channel: e.channel,
          note: e.note,
          velocity: e.velocity,
          seq: e.seq,
        });
        continue;
      }
      if (e.type === "noteOff") {
        const key = `${e.channel}:${e.note}`;
        const stack = active.get(key);
        const start = stack?.pop();
        if (start) {
          notes.push({
            note: e.note,
            velocity: start.velocity,
            channel: e.channel,
            startSec: start.startSec,
            durationSec: Math.max(0.01, sec - start.startSec),
          });
        }
        playEvents.push({ sec, type: "noteOff", channel: e.channel, note: e.note, seq: e.seq });
      }
    }

    return {
      index: idx,
      name: track.trackName || `Track ${idx + 1}`,
      instrumentName: track.instrumentName || "",
      notes: notes.sort((a, b) => a.startSec - b.startSec),
      playEvents: playEvents.sort((a, b) => (a.sec - b.sec) || (a.seq - b.seq)),
    };
  });

  const timeSigEvents = allEvents
    .filter((e): e is ParsedTimeSigEvent => e.type === "timeSig")
    .sort((a, b) => (a.tick - b.tick) || (a.seq - b.seq));
  const primaryTimeSig = timeSigEvents[0] ?? { numerator: 4, denominator: 4 };
  const primaryTempo =
    allEvents
      .filter((e): e is ParsedTempoEvent => e.type === "tempo")
      .sort((a, b) => (a.tick - b.tick) || (a.seq - b.seq))[0]?.microPerQuarter ?? 500000;
  const barTicks = Math.max(1, primaryTimeSig.numerator * division * (4 / primaryTimeSig.denominator));
  const totalBars = Math.max(1, maxTick / barTicks);
  const durationSec = tickToSec(tempoMap, division, maxTick);
  return {
    format,
    division,
    durationSec,
    tracks,
    totalBars,
    bpm: Math.round(60000000 / primaryTempo),
    timeSig: `${primaryTimeSig.numerator}/${primaryTimeSig.denominator}`,
  };
}

let song: Song | null = null;
let ports = new Map<number, MessagePort>();
let trackState: WorkerTrackState[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let playing = false;
let startPerf = 0;
let startSec = 0;
let lastTickEmit = 0;

function clearTimer(): void {
  if (timer != null) clearInterval(timer);
  timer = null;
}

function stopNotes(): void {
  for (const state of trackState) {
    if (!state?.port) continue;
    for (const key of state.active) {
      const note = Number(key.split(":")[1]);
      state.port.postMessage({ type: "noteOff", note });
    }
    state.active.clear();
  }
}

function pauseInternal(): void {
  if (!playing) return;
  const nowSec = startSec + (performance.now() - startPerf) / 1000;
  clearTimer();
  stopNotes();
  playing = false;
  workerGlobal.postMessage({ type: "paused", sec: nowSec });
}

function setTrackPreset(payload: SetTrackPresetMsg): void {
  const state = trackState[payload.trackIndex];
  if (!state?.port) return;
  state.port.postMessage({ type: "setPreset", regions: payload.regions ?? [] });
  state.override = !!payload.override;
  state.presetIndex = payload.presetIndex ?? null;
}

function runTick(): void {
  if (!playing || !song) return;
  const nowSec = startSec + (performance.now() - startPerf) / 1000;
  const lookahead = nowSec + 0.03;

  for (let i = 0; i < song.tracks.length; i += 1) {
    const track = song.tracks[i];
    const state = trackState[i];
    if (!state?.port) continue;
    while (state.nextEventIndex < track.playEvents.length) {
      const ev = track.playEvents[state.nextEventIndex];
      if (ev.sec > lookahead) break;
      if (ev.type === "program") {
        if (!state.override) {
          workerGlobal.postMessage({
            type: "programChangeRequest",
            trackIndex: i,
            program: ev.program,
            bank: ev.bank,
          });
        }
      } else if (ev.type === "noteOn") {
        state.port.postMessage({ type: "noteOn", note: ev.note, velocity: ev.velocity });
        state.active.add(`${ev.channel}:${ev.note}`);
      } else if (ev.type === "noteOff") {
        state.port.postMessage({ type: "noteOff", note: ev.note });
        state.active.delete(`${ev.channel}:${ev.note}`);
      }
      state.nextEventIndex += 1;
    }
  }

  if (nowSec - lastTickEmit > 0.09) {
    workerGlobal.postMessage({ type: "tick", sec: nowSec });
    lastTickEmit = nowSec;
  }

  if (nowSec >= song.durationSec) {
    clearTimer();
    stopNotes();
    playing = false;
    workerGlobal.postMessage({ type: "ended", sec: song.durationSec });
  }
}

workerGlobal.onmessage = (event: MessageEvent<InboundMsg>) => {
  const msg = event.data;
  if (msg.type === "loadMidi") {
    try {
      pauseInternal();
      song = parseMidiBuffer(msg.midiData);
      trackState = (song.tracks ?? []).map((t) => ({
        nextEventIndex: 0,
        active: new Set<string>(),
        override: false,
        presetIndex: null,
        port: ports.get(t.index) ?? null,
      }));
      workerGlobal.postMessage({ type: "songLoaded", song });
    } catch (err) {
      workerGlobal.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (msg.type === "attachPorts") {
    for (const rec of msg.ports ?? []) {
      ports.set(rec.trackIndex, rec.port);
    }
    for (let i = 0; i < trackState.length; i += 1) {
      trackState[i].port = ports.get(i) ?? null;
    }
    return;
  }

  if (msg.type === "setTrackPreset") {
    setTrackPreset(msg);
    return;
  }

  if (msg.type === "play") {
    if (!song) return;
    const sec = Math.max(0, Math.min(song.durationSec, msg.startSec ?? 0));
    startSec = sec;
    startPerf = performance.now();
    for (let i = 0; i < song.tracks.length; i += 1) {
      const track = song.tracks[i];
      const idx = track.playEvents.findIndex((e) => e.sec >= sec);
      const state = trackState[i];
      if (!state) continue;
      state.nextEventIndex = idx >= 0 ? idx : track.playEvents.length;
      state.active.clear();
    }
    lastTickEmit = sec;
    clearTimer();
    timer = setInterval(runTick, 5);
    playing = true;
    return;
  }

  if (msg.type === "pause") {
    pauseInternal();
    return;
  }

  if (msg.type === "seek") {
    if (!song) return;
    const sec = Math.max(0, Math.min(song.durationSec, msg.sec ?? 0));
    for (let i = 0; i < song.tracks.length; i += 1) {
      const track = song.tracks[i];
      const idx = track.playEvents.findIndex((e) => e.sec >= sec);
      const state = trackState[i];
      if (!state) continue;
      state.nextEventIndex = idx >= 0 ? idx : track.playEvents.length;
      state.active.clear();
    }
    startSec = sec;
    startPerf = performance.now();
    workerGlobal.postMessage({ type: "tick", sec });
  }
};
