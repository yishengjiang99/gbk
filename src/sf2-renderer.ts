// SoundFont 2.01 synthesizer. Behaviour mirrors sf2player-swift `Sf2SynthEngine` with
// `SF2Fidelity.spec` (docs/SF2_COMPLIANCE.md); there is no legacy mode. The real-time path
// (dispatchEvent, renderRange, renderScheduled) allocates nothing: voices, channel state and
// scratch buffers are preallocated and reused.
import type { SF2Region, SF2SoundFont, SF2VolEnv, SF2ModEnv } from "./sf2/soundfont.ts";
import {
  type SF2Modulator, type ModInputs, DEFAULT_MODS_204, PITCH_DEST, SLOT_COUNT, modValue, modCurve,
} from "./sf2/modulator.ts";
import { Gen, clampGen, valueRange, roundHalfAway } from "./sf2/geninfo.ts";
import { SF2Effects } from "./sf2/effects.ts";
import { type VoiceOverride, type EffectsParams, computeOverrideDeltas } from "./sf2/voice-overrides.ts";
export type { VoiceOverride, EffectsParams } from "./sf2/voice-overrides.ts";
import { MasterBus, MASTER_GAIN_DEFAULT_DB } from "./sf2/master-bus.ts";
export { MasterBus, MASTER_BUS_DEFAULTS, MASTER_GAIN_DEFAULT_DB, type MasterBusParams } from "./sf2/master-bus.ts";

export type EnvStage = "idle" | "delay" | "attack" | "hold" | "decay" | "sustain" | "release";
const STAGES: EnvStage[] = ["idle", "delay", "attack", "hold", "decay", "sustain", "release"];
const IDLE = 0, DELAY = 1, ATTACK = 2, HOLD = 3, DECAY = 4, SUSTAIN = 5, RELEASE = 6;

export interface VolEnvParams { delayTc?: number; attackTc?: number; holdTc?: number; decayTc?: number; sustainCb?: number; releaseTc?: number }
export interface ModEnvParams { delayTc?: number; attackTc?: number; holdTc?: number; decayTc?: number; sustain?: number; releaseTc?: number }

/** Input element for {@link Sf2SynthEngine.setTrackStates}. */
export interface TrackState {
  trackIndex: number;
  regions?: SF2Region[];
  cc7Volume?: number;
  cc10Pan?: number;
  cc11Expression?: number;
  pan?: number;
  gain?: number;
}

/**
 * Synth event. Types: noteOn / noteOff (note, velocity, channel, trackIndex), setPreset (regions;
 * with `channel` it sets that MIDI channel's preset), setControllers (track gain / pan; CC fields
 * are stored but CC7/10/11 reach voices only through controlChange + the default modulators),
 * controlChange (`controller` or `note` = CC number, `value` or `velocity` = value, channel),
 * pitchBend (`velocity` = 14-bit 0...16383, or `value` = signed -8192...8191, channel),
 * programChange (`program` or `note`; needs loadPrograms), channelPressure (`value`/`velocity`),
 * polyPressure (note, `value`/`velocity`).
 */
export interface SynthEvent {
  type: string;
  frame?: number;
  seq?: number;
  trackIndex?: number | null;
  note?: number;
  velocity?: number;
  value?: number;
  controller?: number;
  program?: number;
  regions?: SF2Region[];
  channel?: number | null;
  cc7Volume?: number;
  cc10Pan?: number;
  cc11Expression?: number;
  pan?: number;
  gain?: number;
  tracks?: TrackState[];
  maxVoices?: number;
  events?: SynthEvent[];
  /** setVoiceOverrides: generator overrides for `trackIndex` (-1 / absent = every voice of this engine). */
  overrides?: VoiceOverride[] | null;
  /** setVoiceOverrides: also refresh realtime generators of sounding voices. */
  updateActive?: boolean;
  /** setEffects: global reverb / chorus parameters. */
  effects?: Partial<EffectsParams>;
}

// ── DSP helpers (Double math like the Swift port) ─────────────────────────────

export function timecentsToSeconds(tc: number): number { return Math.pow(2, tc / 1200); }
export function centsToRatio(c: number): number { return Math.pow(2, c / 1200); }
export function cbAttenToLin(cb: number): number { return Math.pow(10, (-cb / 10) / 20); }
export function fcCentsToHz(fc: number): number { return 8.176 * Math.pow(2, fc / 1200); }

class VolEnv {
  stage = IDLE;
  level = 0; t = 0;
  delay = 0; attack = 0.01; hold = 0; decay = 0.1; releaseSec = 0.001;
  sustainCb = 0; attCb = 0;
  constructor(readonly sr: number) {}
  reset(): void {
    this.stage = IDLE; this.level = 0; this.t = 0; this.delay = 0; this.attack = 0.01; this.hold = 0; this.decay = 0.1;
    this.releaseSec = 0.001; this.sustainCb = 0; this.attCb = 0;
  }
  setFromSf2(e: SF2VolEnv): void {
    this.delay = Math.max(0, timecentsToSeconds(e.delayTc));
    this.attack = Math.max(0, timecentsToSeconds(e.attackTc));
    this.hold = Math.max(0, timecentsToSeconds(e.holdTc));
    this.decay = Math.max(0, timecentsToSeconds(e.decayTc));
    this.releaseSec = Math.max(0, timecentsToSeconds(e.releaseTc));
    this.sustainCb = Math.max(0, Math.min(1440, e.sustainCb));
  }
  noteOn(): void { this.stage = this.delay > 0 ? DELAY : ATTACK; this.t = 0; this.level = 0; }
  noteOff(): void {
    if (this.stage === IDLE) return;
    this.stage = RELEASE;
    this.t = 0;
    this.attCb = this.level > 0 ? Math.min(960, -200 * Math.log10(this.level)) : 960;
  }
  /** G-12: release from the current level, 100 dB in `seconds`. */
  fastRelease(seconds: number): void {
    if (this.stage === IDLE) return;
    this.releaseSec = seconds;
    this.noteOff();
  }
  kill(): void { this.stage = IDLE; this.level = 0; }
  /** G-03 (9.1.7): linear attack, constant dB/s decay and release from the current level, ends at 96 dB. */
  next(): number {
    const dt = 1 / this.sr;
    switch (this.stage) {
      case IDLE: this.level = 0; return 0;
      case DELAY:
        this.t += dt;
        if (this.t >= this.delay) { this.stage = ATTACK; this.t = 0; }
        this.level = 0;
        return 0;
      case ATTACK:
        this.t += dt;
        if (this.attack <= 0 || this.t >= this.attack) {
          this.level = 1; this.stage = this.hold > 0 ? HOLD : DECAY; this.t = 0; this.attCb = 0; return this.level;
        }
        this.level = this.t / this.attack;
        return this.level;
      case HOLD:
        this.t += dt;
        this.level = 1;
        if (this.t >= this.hold) { this.stage = DECAY; this.t = 0; this.attCb = 0; }
        return this.level;
      case DECAY:
        this.attCb = this.decay <= 0 ? this.sustainCb : this.attCb + (1000 * dt) / this.decay;
        if (this.attCb >= this.sustainCb) { this.attCb = this.sustainCb; this.stage = SUSTAIN; }
        if (this.attCb >= 960) { this.level = 0; this.stage = IDLE; return 0; }
        this.level = Math.pow(10, -this.attCb / 200);
        return this.level;
      case SUSTAIN:
        if (this.sustainCb >= 960) { this.level = 0; this.stage = IDLE; return 0; }
        this.level = Math.pow(10, -this.sustainCb / 200);
        return this.level;
      default:
        this.attCb = this.releaseSec <= 0 ? 960 : this.attCb + (1000 * dt) / this.releaseSec;
        if (this.attCb >= 960) { this.level = 0; this.stage = IDLE; return 0; }
        this.level = Math.pow(10, -this.attCb / 200);
        return this.level;
    }
  }
}

export class ModEnv {
  stage = IDLE;
  level = 0; t = 0;
  delay = 0; attack = 0.01; hold = 0; decay = 0.1; sustain = 0; releaseSec = 0.001;
  constructor(readonly sr: number) {}
  reset(): void {
    this.stage = IDLE; this.level = 0; this.t = 0; this.delay = 0; this.attack = 0.01; this.hold = 0; this.decay = 0.1;
    this.sustain = 0; this.releaseSec = 0.001;
  }
  setFromSf2(e: SF2ModEnv): void {
    this.delay = Math.max(0, timecentsToSeconds(e.delayTc));
    this.attack = Math.max(0, timecentsToSeconds(e.attackTc));
    this.hold = Math.max(0, timecentsToSeconds(e.holdTc));
    this.decay = Math.max(0, timecentsToSeconds(e.decayTc));
    this.releaseSec = Math.max(0, timecentsToSeconds(e.releaseTc));
    this.sustain = Math.min(1, Math.max(0, e.sustain));
  }
  noteOn(): void { this.stage = this.delay > 0 ? DELAY : ATTACK; this.t = 0; this.level = 0; }
  noteOff(): void {
    if (this.stage === IDLE) return;
    this.stage = RELEASE;
    this.t = 0;
  }
  /** G-04: convex attack, linear decay / release at full scale per decay / release seconds. */
  next(): number {
    const dt = 1 / this.sr;
    switch (this.stage) {
      case IDLE: this.level = 0; return 0;
      case DELAY:
        this.t += dt;
        if (this.t >= this.delay) { this.stage = ATTACK; this.t = 0; }
        this.level = 0;
        return 0;
      case ATTACK:
        this.t += dt;
        if (this.attack <= 0 || this.t >= this.attack) { this.level = 1; this.stage = this.hold > 0 ? HOLD : DECAY; this.t = 0; return 1; }
        this.level = modCurve(2, this.t / this.attack);
        return this.level;
      case HOLD:
        this.t += dt;
        this.level = 1;
        if (this.t >= this.hold) { this.stage = DECAY; this.t = 0; }
        return 1;
      case DECAY:
        this.level = this.decay <= 0 ? this.sustain : this.level - dt / this.decay;
        if (this.level <= this.sustain) { this.level = this.sustain; this.stage = SUSTAIN; }
        return this.level;
      case SUSTAIN:
        this.level = this.sustain;
        return this.level;
      default:
        this.level = this.releaseSec <= 0 ? 0 : this.level - dt / this.releaseSec;
        if (this.level <= 0) { this.level = 0; this.stage = IDLE; }
        return this.level;
    }
  }
}

/** G-06: triangle LFO, starting at 0 rising. */
class LFO {
  phase = 0; freqHz = 5; delayLeft = 0;
  constructor(readonly sr: number) {}
  reset(): void { this.phase = 0; this.freqHz = 5; this.delayLeft = 0; }
  set(freqHz: number, delaySec: number): void { this.freqHz = Math.max(0, freqHz); this.delayLeft = Math.max(0, delaySec); }
  next(): number {
    if (this.delayLeft > 0) { this.delayLeft -= 1 / this.sr; return 0; }
    this.phase += (2 * Math.PI * this.freqHz) / this.sr;
    if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
    const p = this.phase / (2 * Math.PI);
    return p < 0.25 ? 4 * p : (p < 0.75 ? 2 - 4 * p : 4 * p - 4);
  }
}

class TwoPoleLPF {
  z1L = 0; z2L = 0; z1R = 0; z2R = 0;
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  q = 0.7071;
  constructor(readonly sr: number) {}
  reset(): void { this.z1L = 0; this.z2L = 0; this.z1R = 0; this.z2R = 0; this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.q = 0.7071; }
  setCutoffHz(hz: number): void {
    const clamped = Math.max(5, Math.min(hz, this.sr * 0.45));
    const w0 = (2 * Math.PI * clamped) / this.sr;
    const cosw0 = Math.cos(w0);
    const sinw0 = Math.sin(w0);
    const alpha = sinw0 / (2 * this.q);
    const a0 = 1 + alpha;
    this.b0 = ((1 - cosw0) / 2) / a0;
    this.b1 = (1 - cosw0) / a0;
    this.b2 = ((1 - cosw0) / 2) / a0;
    this.a1 = (-2 * cosw0) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  processL(x: number): number {
    const y = this.b0 * x + this.z1L;
    this.z1L = this.b1 * x - this.a1 * y + this.z2L;
    this.z2L = this.b2 * x - this.a2 * y;
    return y;
  }
  processR(x: number): number {
    const y = this.b0 * x + this.z1R;
    this.z1R = this.b1 * x - this.a1 * y + this.z2R;
    this.z2R = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** Internal voice state (exposed read-only for tests via Sf2SynthEngine.debugVoice). */
export class Sf2Voice {
  note = 0; channel = 0; trackIndex = -1; velocity = 0;
  pos = 0; baseRate = 1; rate = 1;
  start = 0; end = 0; loopStart = 0; loopEnd = 0;
  looping = false; loopUntilReleaseThenTail = false; inReleaseTail = false; finished = false;
  dataL: Float32Array = EMPTY; dataR: Float32Array | null = null;
  baseGain = 0; regionPanPos = 0; trackPanPos = 0; trackVolumeMul = 1;
  readonly volEnv: VolEnv; readonly modEnv: ModEnv; readonly modLfo: LFO; readonly vibLfo: LFO; readonly lpf: TwoPoleLPF;
  exclusiveClass = 0;
  vibToPitch = 0; modToPitch = 0; initialFc = 13500; modEnvToFc = 0; modLfoToFc = 0;
  lastFc = NaN; lastMixPan = NaN; gL = 0; gR = 0;
  mods: readonly SF2Modulator[] | null = null;
  regAtten = 0; regPan = 0; regFc = 13500; regQ = 0; regVib = 0; regModPitch = 0;
  regModEnvPitch = 0; regModLfoFc = 0; regModEnvFc = 0; regModLfoVol = 0;
  baseRate0 = 1; trackGain = 1; modEnvToPitch = 0; modLfoToVol = 0;
  keyDown = true; deferred = false; sostenuto = false;
  list: SF2Region[] | null = null;
  effKey = 0; effVel = 0;
  chorusAmt = 0; reverbAmt = 0; regChorus = 0; regReverb = 0;
  qCb = 0;
  /** GBK voice-override generator deltas (native units), applied with the modulator sums. */
  readonly ovr = new Float64Array(61); hasOvr = false; hasSendMods = false;
  region: SF2Region | null = null;
  constructor(sr: number) {
    this.volEnv = new VolEnv(sr); this.modEnv = new ModEnv(sr); this.modLfo = new LFO(sr); this.vibLfo = new LFO(sr); this.lpf = new TwoPoleLPF(sr);
  }
  reset(): void {
    this.note = 0; this.channel = 0; this.trackIndex = -1; this.velocity = 0;
    this.pos = 0; this.baseRate = 1; this.rate = 1; this.start = 0; this.end = 0; this.loopStart = 0; this.loopEnd = 0;
    this.looping = false; this.loopUntilReleaseThenTail = false; this.inReleaseTail = false; this.finished = false;
    this.dataL = EMPTY; this.dataR = null; this.baseGain = 0; this.regionPanPos = 0; this.trackPanPos = 0; this.trackVolumeMul = 1;
    this.volEnv.reset(); this.modEnv.reset(); this.modLfo.reset(); this.vibLfo.reset(); this.lpf.reset();
    this.exclusiveClass = 0; this.vibToPitch = 0; this.modToPitch = 0; this.initialFc = 13500; this.modEnvToFc = 0; this.modLfoToFc = 0;
    this.lastFc = NaN; this.lastMixPan = NaN; this.gL = 0; this.gR = 0; this.mods = null;
    this.regAtten = 0; this.regPan = 0; this.regFc = 13500; this.regQ = 0; this.regVib = 0; this.regModPitch = 0;
    this.regModEnvPitch = 0; this.regModLfoFc = 0; this.regModEnvFc = 0; this.regModLfoVol = 0;
    this.baseRate0 = 1; this.trackGain = 1; this.modEnvToPitch = 0; this.modLfoToVol = 0;
    this.keyDown = true; this.deferred = false; this.sostenuto = false; this.list = null; this.effKey = 0; this.effVel = 0;
    this.chorusAmt = 0; this.reverbAmt = 0; this.regChorus = 0; this.regReverb = 0; this.qCb = 0;
    if (this.hasOvr) this.ovr.fill(0);
    this.hasOvr = false; this.hasSendMods = false; this.region = null;
  }
}
const EMPTY = new Float32Array(1);

function readSampleMono(data: Float32Array, pos: number): number {
  // Non-finite / absurd positions (pathological tuning) read silence.
  if (!Number.isFinite(pos) || !(Math.abs(pos) < 9e15)) return 0;
  const i = Math.trunc(pos);
  const f = pos - i;
  const len = data.length;
  const a = i >= 0 && i < len ? data[i] : 0;
  const b = i + 1 >= 0 && i + 1 < len ? data[i + 1] : 0;
  return a + (b - a) * f;
}

/**
 * Per-track state. When a track carries explicit CC7/CC10/CC11 (`ccSet`), those values are written into the
 * MIDI channel controller state of every channel the track plays on (`chanMask`), so they act through the
 * 2.01 default modulators (8.4.5 CC7 / 8.4.6 CC10 / 8.4.7 CC11) exactly like in-stream controller events.
 */
interface TrackRT { present: boolean; list: SF2Region[] | null; cc7: number; cc10: number; cc11: number; pan: number; gain: number; ccSet: boolean; chanMask: number }
function resetTrack(t: TrackRT): void { t.present = false; t.list = null; t.cc7 = 100; t.cc10 = 64; t.cc11 = 127; t.pan = 0; t.gain = 1; t.ccSet = false; t.chanMask = 0; }

export class ChannelRT {
  bend = 8192; pws = 2; rpnMsb = 127; rpnLsb = 127; pressure = 0;
  list: SF2Region[] | null = null; program = 0;
  paramIsNRPN = false; nrpnActive = false; nrpnSelect = -1; nrpnAccum = 0; sostenuto = false;
  reset(): void {
    this.bend = 8192; this.pws = 2; this.rpnMsb = 127; this.rpnLsb = 127; this.pressure = 0; this.list = null; this.program = 0;
    this.paramIsNRPN = false; this.nrpnActive = false; this.nrpnSelect = -1; this.nrpnAccum = 0; this.sostenuto = false;
  }
}

export interface Sf2VoiceSnapshot {
  note: number; velocity: number; channel: number; trackIndex: number | null;
  volEnvStage: EnvStage; volEnvLevel: number; baseGain: number;
}

interface Sf2SynthEngineOptions { maxVoices?: number; voiceCapacity?: number }

const MAX_TRACKS = 256;
const ev = (x: number | null | undefined, d: number) => (typeof x === "number" && Number.isFinite(x) ? x : d);
const iv = (x: number | null | undefined) => (typeof x === "number" && Number.isFinite(x) ? Math.trunc(x) : -1);

export class Sf2SynthEngine {
  static readonly maxTracks = MAX_TRACKS;
  static readonly softPedalAttenuationCb = 60;
  static readonly softPedalFcCents = 600;
  static readonly exclusiveReleaseSec = 0.005;

  readonly outSr: number;
  maxVoices: number;
  private capacity: number;
  private pool: Sf2Voice[];
  private order: Int32Array;
  private free: Int32Array;
  private freeCount: number;
  private count = 0;
  cc7Volume = 100; cc10Pan = 64; cc11Expression = 127;
  private globalList: SF2Region[] | null = null;
  private tracks: TrackRT[];
  private chans: ChannelRT[];
  private ccs = new Uint8Array(16 * 128);
  private nrpn = new Float64Array(16 * 64);
  private poly = new Uint8Array(16 * 128);
  private programs: (SF2Region[] | null)[] = new Array(129 * 128).fill(null);
  private scratch = new Float64Array(SLOT_COUNT);
  private inputs: ModInputs;
  private revL = 0; private revR = 0; private choL = 0; private choR = 0;
  private fx: SF2Effects;
  /** G-11: mix the built-in reverb / chorus into renderRange / renderScheduled. */
  effectsEnabled = true;
  /**
   * GBK extension: SoundFont 2.01 default modulators 8.4.8 (CC91 -> reverb send, 200) and 8.4.9 (CC93 -> chorus
   * send, 200) for voices whose modulator list has none (2.04 files and hand-built regions omit them). Off in the
   * cross-engine parity renderer because sf2player-swift does not implement this extension.
   */
  sendCcModulators = true;
  private frameL = 0; private frameR = 0;
  /** Voice overrides by trackIndex + 1 (slot 0 = trackIndex -1 = all voices of this engine). */
  private overrides: (VoiceOverride[] | null)[] = new Array(MAX_TRACKS + 1).fill(null);

  constructor(outSr: number, options: Sf2SynthEngineOptions = {}) {
    this.outSr = outSr;
    this.maxVoices = Math.max(1, options.maxVoices ?? 64);
    this.capacity = Math.max(this.maxVoices, options.voiceCapacity ?? this.maxVoices);
    this.pool = Array.from({ length: this.capacity }, () => new Sf2Voice(outSr));
    this.order = new Int32Array(this.capacity);
    this.free = new Int32Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) this.free[i] = this.capacity - 1 - i;
    this.freeCount = this.capacity;
    this.tracks = Array.from({ length: MAX_TRACKS }, () => { const t = {} as TrackRT; resetTrack(t); return t; });
    this.chans = Array.from({ length: 16 }, () => new ChannelRT());
    this.inputs = { velocity: 0, key: 0, cc: this.ccs, ccBase: 0, pitchWheel: 8192, pitchWheelSensitivity: 2, channelPressure: 0, polyPressure: 0 };
    this.fx = new SF2Effects(outSr);
    this.master = new MasterBus(outSr);
    this.resetChannels();
  }

  // ── inspection / non-real-time API ─────────────────────────────────────────

  get voiceCount(): number { return this.count; }
  get voiceCapacity(): number { return this.capacity; }
  get voices(): Sf2VoiceSnapshot[] {
    const out: Sf2VoiceSnapshot[] = [];
    for (let i = 0; i < this.count; i++) {
      const v = this.pool[this.order[i]];
      out.push({ note: v.note, velocity: v.velocity, channel: v.channel, trackIndex: v.trackIndex < 0 ? null : v.trackIndex,
        volEnvStage: STAGES[v.volEnv.stage], volEnvLevel: v.volEnv.level, baseGain: v.baseGain });
    }
    return out;
  }
  get regions(): SF2Region[] { return this.globalList ?? []; }
  set regions(r: SF2Region[]) { this.globalList = r; }
  get trackStates(): Map<number, { regions: SF2Region[]; cc7Volume: number; cc10Pan: number; cc11Expression: number; pan: number; gain: number }> {
    const m = new Map();
    this.tracks.forEach((t, i) => {
      if (t.present) m.set(i, { regions: t.list ?? [], cc7Volume: t.cc7, cc10Pan: t.cc10, cc11Expression: t.cc11, pan: t.pan, gain: t.gain });
    });
    return m;
  }
  controller(cc: number, channel: number): number {
    return channel >= 0 && channel < 16 && cc >= 0 && cc < 128 ? this.ccs[channel * 128 + cc] : 0;
  }
  pitchBend(channel: number): number { return channel >= 0 && channel < 16 ? this.chans[channel].bend : 8192; }
  pitchBendRange(channel: number): number { return channel >= 0 && channel < 16 ? this.chans[channel].pws : 2; }

  /** Non-real-time: grows the pool if needed. */
  setMaxVoices(n: number): void {
    const mv = Math.max(1, n ?? this.maxVoices);
    if (mv > this.capacity) {
      const old = this.capacity;
      for (let i = old; i < mv; i++) this.pool.push(new Sf2Voice(this.outSr));
      const order = new Int32Array(mv); order.set(this.order.subarray(0, this.count));
      const free = new Int32Array(mv); free.set(this.free.subarray(0, this.freeCount));
      let fc = this.freeCount;
      for (let slot = mv - 1; slot >= old; slot--) free[fc++] = slot;
      this.order = order; this.free = free; this.freeCount = fc; this.capacity = mv;
    }
    this.maxVoices = mv;
  }

  setTrackStates(tracks: TrackState[]): void {
    for (const t of this.tracks) resetTrack(t);
    this.resetChannels();
    for (const t of tracks ?? []) {
      if (!(t.trackIndex >= 0 && t.trackIndex < MAX_TRACKS)) continue;
      const r = this.tracks[t.trackIndex];
      r.present = true;
      r.list = t.regions ?? null;
      r.cc7 = Math.max(0, Math.min(127, t.cc7Volume ?? 100));
      r.cc10 = Math.max(0, Math.min(127, t.cc10Pan ?? 64));
      r.cc11 = Math.max(0, Math.min(127, t.cc11Expression ?? 127));
      // Power-on defaults are already the channel state; only non-default track CCs override in-stream CCs.
      r.ccSet = r.cc7 !== 100 || r.cc10 !== 64 || r.cc11 !== 127;
      r.pan = Math.max(-1, Math.min(1, t.pan ?? 0));
      r.gain = Math.max(0, t.gain ?? 1);
    }
    this.clearVoices();
  }

  /** MIDI power-on channel state: CC7 100, CC10 64, CC11 127, others 0; bend center, range 2. */
  resetChannels(): void {
    this.cc7Volume = 100; this.cc10Pan = 64; this.cc11Expression = 127;
    for (let c = 0; c < 16; c++) {
      this.chans[c].reset();
      const b = c * 128;
      this.ccs.fill(0, b, b + 128);
      this.ccs[b + 7] = 100; this.ccs[b + 10] = 64; this.ccs[b + 11] = 127;
      this.ccs[b + 100] = 127; this.ccs[b + 101] = 127;
      this.nrpn.fill(0, c * 64, c * 64 + 64);
      this.poly.fill(0, b, b + 128);
    }
  }

  /** Non-real-time: (bank 0...128, program 0...127) -> region list for programChange (MIDI-07). */
  loadPrograms(sf: SF2SoundFont): void {
    const byPreset = new Map<number, SF2Region[]>();
    for (let bank = 0; bank <= 128; bank++) {
      for (let prog = 0; prog <= 127; prog++) {
        let list: SF2Region[] | null = null;
        const p = sf.resolvePresetIndex(prog, bank);
        if (p !== null) {
          list = byPreset.get(p) ?? null;
          if (!list) { list = sf.regionList(p); byPreset.set(p, list); }
        }
        this.programs[bank * 128 + prog] = list;
      }
    }
  }

  clearVoices(): void {
    this.count = 0;
    for (let i = 0; i < this.capacity; i++) this.free[i] = this.capacity - 1 - i;
    this.freeCount = this.capacity;
  }

  resetEffects(): void { this.fx.clear(); this.master.reset(); }

  /** Releases every voice (note-off semantics). */
  releaseAll(): void {
    for (let i = 0; i < this.count; i++) {
      const v = this.pool[this.order[i]];
      v.volEnv.noteOff(); v.modEnv.noteOff();
      if (v.loopUntilReleaseThenTail) v.inReleaseTail = true;
    }
  }

  pickRegions(note: number, velocity: number, regions: SF2Region[] = this.regions): SF2Region[] {
    return regions.filter((r) => note >= r.keyRange[0] && note <= r.keyRange[1] && velocity >= r.velRange[0] && velocity <= r.velRange[1]);
  }

  /** Tests / inspection only: SoundFont NRPN offset (N-04) for a channel and generator. */
  debugNrpn(channel: number, gen: number): number { return this.nrpn[channel * 64 + gen]; }
  /** Tests / inspection only: a channel's real-time state. */
  debugChannel(channel: number): Readonly<ChannelRT> { return this.chans[channel]; }
  /** Tests / inspection only: the i-th sounding voice's internal state. */
  debugVoice(i: number): Sf2Voice | undefined { return i < this.count ? this.pool[this.order[i]] : undefined; }

  // ── real-time core ─────────────────────────────────────────────────────────

  private removeVoice(idx: number): void {
    const slot = this.order[idx];
    const n = this.count;
    for (let i = idx; i < n - 1; i++) this.order[i] = this.order[i + 1];
    this.count = n - 1;
    this.free[this.freeCount++] = slot;
  }

  dispatchEvent(msg: SynthEvent): void {
    if (!msg) return;
    const trackIndex = iv(msg.trackIndex);
    const channel = iv(msg.channel);
    switch (msg.type) {
      case "setPreset": {
        const list = msg.regions ?? null;
        if (channel >= 0 && channel < 16) { this.chans[channel].list = list; return; }
        if (trackIndex >= 0) {
          if (trackIndex < MAX_TRACKS && this.tracks[trackIndex].present) this.tracks[trackIndex].list = list;
          return;
        }
        this.globalList = list;
        this.clearVoices();
        return;
      }
      case "noteOn": {
        const note = Math.trunc(ev(msg.note, 0));
        const velocity = Math.trunc(ev(msg.velocity, 0));
        if (velocity === 0) { this.keyOff(note, trackIndex, channel); return; }   // MIDI-01
        const track = trackIndex >= 0 && trackIndex < MAX_TRACKS && this.tracks[trackIndex].present ? this.tracks[trackIndex] : null;
        let list = track ? track.list : this.globalList;
        if (channel >= 0 && channel < 16 && this.chans[channel].list) list = this.chans[channel].list;
        if (!list || list.length === 0) return;
        let any = false;
        const ch = channel >= 0 ? channel : 0;
        for (let k = 0; k < list.length; k++) {
          const r = list[k];
          if (note >= r.keyRange[0] && note <= r.keyRange[1] && velocity >= r.velRange[0] && velocity <= r.velRange[1]) {
            any = true;
            if (r.exclusiveClass) this.chokeExclusive(r.exclusiveClass, ch, list);
          }
        }
        if (!any) return;
        if (track && track.ccSet && (track.chanMask & (1 << ch)) === 0) {
          track.chanMask |= 1 << ch;
          this.applyTrackCcs(track, ch);
        }
        const trackGain = track ? track.gain : 1;
        const trackPan = track ? track.pan : 0;
        for (let k = 0; k < list.length; k++) {
          const r = list[k];
          if (!(note >= r.keyRange[0] && note <= r.keyRange[1] && velocity >= r.velRange[0] && velocity <= r.velRange[1])) continue;
          this.ensurePolyphony();
          if (this.freeCount <= 0) continue;
          const slot = this.free[--this.freeCount];
          this.makeVoice(this.pool[slot], r, note, velocity, ch, trackIndex, trackPan, trackGain, list);
          this.order[this.count++] = slot;
        }
        return;
      }
      case "noteOff":
        this.keyOff(Math.trunc(ev(msg.note, 0)), trackIndex, channel);
        return;
      case "setControllers": {
        const cc = (x: number) => Math.max(0, Math.min(127, x | 0));
        if (trackIndex >= 0) {
          if (!(trackIndex < MAX_TRACKS && this.tracks[trackIndex].present)) return;
          const t = this.tracks[trackIndex];
          if (Number.isFinite(msg.cc7Volume)) t.cc7 = cc(msg.cc7Volume!);
          if (Number.isFinite(msg.cc10Pan)) t.cc10 = cc(msg.cc10Pan!);
          if (Number.isFinite(msg.cc11Expression)) t.cc11 = cc(msg.cc11Expression!);
          if (Number.isFinite(msg.pan)) t.pan = Math.max(-1, Math.min(1, msg.pan!));
          if (Number.isFinite(msg.gain)) t.gain = Math.max(0, msg.gain!);
          if (Number.isFinite(msg.cc7Volume) || Number.isFinite(msg.cc10Pan) || Number.isFinite(msg.cc11Expression)) {
            t.ccSet = true;
            for (let c = 0; c < 16; c++) if (t.chanMask & (1 << c)) this.applyTrackCcs(t, c);
          }
          return;
        }
        // Engine-wide (one engine per app track): CC7/10/11 go to every channel's controller state.
        if (Number.isFinite(msg.cc7Volume)) { this.cc7Volume = cc(msg.cc7Volume!); for (let c = 0; c < 16; c++) this.controlChange(c, 7, this.cc7Volume); }
        if (Number.isFinite(msg.cc10Pan)) { this.cc10Pan = cc(msg.cc10Pan!); for (let c = 0; c < 16; c++) this.controlChange(c, 10, this.cc10Pan); }
        if (Number.isFinite(msg.cc11Expression)) { this.cc11Expression = cc(msg.cc11Expression!); for (let c = 0; c < 16; c++) this.controlChange(c, 11, this.cc11Expression); }
        return;
      }
      case "controlChange": {
        const num = Math.trunc(ev(msg.controller, ev(msg.note, -1)));
        const value = Math.trunc(ev(msg.value, ev(msg.velocity, 0)));
        if (!(channel >= 0 && channel < 16 && num >= 0 && num < 128)) return;
        this.controlChange(channel, num, Math.max(0, Math.min(127, value)));
        return;
      }
      case "programChange": {
        const prog = Math.trunc(ev(msg.program, ev(msg.note, -1)));
        if (!(channel >= 0 && channel < 16 && prog >= 0 && prog < 128)) return;
        this.chans[channel].program = prog;
        const bank = channel === 9 ? 128 : this.ccs[channel * 128];
        this.chans[channel].list = this.programs[bank * 128 + prog];
        return;
      }
      case "channelPressure": {
        if (!(channel >= 0 && channel < 16)) return;
        this.chans[channel].pressure = Math.max(0, Math.min(127, Math.trunc(ev(msg.value, ev(msg.velocity, 0)))));
        this.updateChannelVoices(channel);
        return;
      }
      case "polyPressure": {
        const note = Math.trunc(ev(msg.note, -1));
        if (!(channel >= 0 && channel < 16 && note >= 0 && note < 128)) return;
        this.poly[channel * 128 + note] = Math.max(0, Math.min(127, Math.trunc(ev(msg.value, ev(msg.velocity, 0)))));
        this.updateChannelVoices(channel);
        return;
      }
      case "pitchBend": {
        if (!(channel >= 0 && channel < 16)) return;
        const bend = typeof msg.velocity === "number" ? msg.velocity : ev(msg.value, 0) + 8192;
        this.chans[channel].bend = Math.max(0, Math.min(16383, Math.trunc(bend)));
        this.updateChannelVoices(channel);
        return;
      }
      case "setVoiceOverrides":
        this.setVoiceOverrides(trackIndex, msg.overrides ?? null, !!msg.updateActive);
        return;
      case "setEffects":
        if (msg.effects) this.setEffectParams(msg.effects);
        return;
      default:
        return;
    }
  }

  /** Non-real-time: install generator overrides for a track (trackIndex < 0 = all voices). */
  setVoiceOverrides(trackIndex: number, list: VoiceOverride[] | null, updateActive = false): void {
    const slot = trackIndex >= 0 && trackIndex < MAX_TRACKS ? trackIndex + 1 : 0;
    this.overrides[slot] = list && list.length ? list.slice() : null;
    if (!updateActive) return;
    const d = this.scratch;
    for (let i = 0; i < this.count; i++) {
      const v = this.pool[this.order[i]];
      if (!v.region || (slot !== 0 && v.trackIndex !== trackIndex)) continue;
      this.loadOverrides(v, v.region, v.effKey);
      // Realtime generators (filter, pitch, LFO depths, pan, attenuation, sends) follow immediately;
      // envelope times / LFO rates are note-on only (SF2 8.1.3 semantics).
      this.evalMods(v, d);
      this.applyLive(v, d);
    }
  }
  getVoiceOverrides(trackIndex: number): VoiceOverride[] | null {
    return this.overrides[trackIndex >= 0 && trackIndex < MAX_TRACKS ? trackIndex + 1 : 0];
  }

  /** Global reverb / chorus parameters (enabled=false is the off switch). */
  setEffectParams(p: Partial<EffectsParams>): void {
    if (typeof p.enabled === "boolean") this.effectsEnabled = p.enabled;
    this.fx.setParams(p);
  }

  private loadOverrides(v: Sf2Voice, reg: SF2Region, key: number): void {
    const t = v.trackIndex >= 0 && v.trackIndex < MAX_TRACKS ? this.overrides[v.trackIndex + 1] : null;
    const g = this.overrides[0];
    let any = computeOverrideDeltas(g, reg, key, v.ovr);
    if (t) {
      const d = this.scratch2;
      if (computeOverrideDeltas(t, reg, key, d)) { for (let k = 0; k < 61; k++) v.ovr[k] += d[k]; any = true; }
    }
    v.hasOvr = any;
  }
  private scratch2 = new Float64Array(61);

  private applyTrackCcs(t: TrackRT, ch: number): void {
    this.controlChange(ch, 7, t.cc7); this.controlChange(ch, 10, t.cc10); this.controlChange(ch, 11, t.cc11);
  }

  /** MIDI-02/03 key-off: deferred while CC64 is down or the note is held by sostenuto. */
  private keyOff(note: number, trackIndex: number, channel: number): void {
    for (let i = 0; i < this.count; i++) {
      const v = this.pool[this.order[i]];
      const sameTrack = trackIndex < 0 || v.trackIndex === trackIndex;
      const sameChannel = channel < 0 || v.channel === channel;
      if (v.note === note && sameTrack && sameChannel && v.keyDown) this.keyOffVoice(v);
    }
  }

  private keyOffVoice(v: Sf2Voice): void {
    v.keyDown = false;
    const c = Math.max(0, Math.min(15, v.channel));
    if (this.ccs[c * 128 + 64] >= 64 || v.sostenuto) { v.deferred = true; return; }
    v.deferred = false;
    v.volEnv.noteOff(); v.modEnv.noteOff();
    if (v.loopUntilReleaseThenTail) v.inReleaseTail = true;
  }

  private releaseDeferred(channel: number): void {
    const sustain = this.ccs[channel * 128 + 64] >= 64;
    for (let i = 0; i < this.count; i++) {
      const v = this.pool[this.order[i]];
      if (v.channel !== channel || !v.deferred || sustain || v.sostenuto) continue;
      v.deferred = false;
      v.volEnv.noteOff(); v.modEnv.noteOff();
      if (v.loopUntilReleaseThenTail) v.inReleaseTail = true;
    }
  }

  /** G-12 (8.1.2 #57): fast release of same-class voices of the same preset (region list) and channel. */
  private chokeExclusive(exclusiveClass: number, channel: number, list: SF2Region[]): void {
    for (let i = 0; i < this.count; i++) {
      const v = this.pool[this.order[i]];
      if (v.exclusiveClass !== exclusiveClass || v.channel !== channel || v.list !== list) continue;
      v.volEnv.fastRelease(Sf2SynthEngine.exclusiveReleaseSec); v.modEnv.noteOff();
      v.keyDown = false; v.deferred = false; v.sostenuto = false;
      if (v.loopUntilReleaseThenTail) v.inReleaseTail = true;
    }
  }

  private ensurePolyphony(): void {
    if (this.count < this.maxVoices) return;
    let minIdx = 0, minVal = Infinity;
    for (let i = 0; i < this.count; i++) {
      const v = this.pool[this.order[i]];
      const loudness = v.volEnv.level * v.baseGain;
      if (loudness < minVal) { minVal = loudness; minIdx = i; }
    }
    if (this.count > 0) this.removeVoice(minIdx);
  }

  private makeVoice(v: Sf2Voice, reg: SF2Region, note: number, velocity: number, channel: number, trackIndex: number,
    trackPanPos: number, trackGain: number, list: SF2Region[]): void {
    v.reset();
    v.list = list;
    // G-02: substitution generators.
    const effKey = reg.keynumOverride != null && reg.keynumOverride >= 0 ? reg.keynumOverride : note;
    const effVel = reg.velocityOverride != null && reg.velocityOverride >= 0 ? reg.velocityOverride : velocity;
    v.effKey = effKey; v.effVel = effVel;
    v.note = note; v.channel = channel; v.trackIndex = trackIndex; v.velocity = velocity;
    const s = reg.sample;
    v.start = s.start; v.end = s.end; v.loopStart = s.loopStart; v.loopEnd = s.loopEnd;
    v.pos = v.start;
    const modes = reg.sampleModes;
    v.looping = modes === 1 || modes === 3;
    v.loopUntilReleaseThenTail = modes === 3;
    const root = reg.overridingRootKey ?? reg.originalKey;
    const keyTrackCents = (effKey - root) * reg.scaleTuning;
    const tuneCents = reg.coarseTune * 100 + reg.fineTune;
    const srRatio = s.sampleRate / this.outSr;
    v.baseRate = centsToRatio(keyTrackCents + tuneCents) * srRatio;
    v.rate = v.baseRate;
    v.dataL = s.dataL; v.dataR = s.dataR ?? null;
    v.trackPanPos = Math.max(-1, Math.min(1, trackPanPos));
    v.exclusiveClass = reg.exclusiveClass;
    v.vibToPitch = reg.vibLfoToPitchCents; v.modToPitch = reg.modLfoToPitchCents;
    v.modEnvToFc = reg.modEnvToFilterFcCents; v.modLfoToFc = reg.modLfoToFilterFcCents;
    v.region = reg;
    this.loadOverrides(v, reg, effKey);
    this.specVoice(v, reg, effKey, trackGain);
    v.volEnv.noteOn();
    v.modEnv.noteOn();
  }

  private evalMods(v: Sf2Voice, d: Float64Array): void {
    d.fill(0);
    const c = Math.max(0, Math.min(15, v.channel));
    for (let k = 0; k < 64; k++) d[k] = this.nrpn[c * 64 + k];   // N-04
    if (v.hasOvr) for (let k = 0; k < 61; k++) d[k] += v.ovr[k];
    if (this.sendCcModulators && !v.hasSendMods) {
      const cc = this.ccs, b = c * 128;
      if (cc[b + 91] !== 0) d[16] += 200 * (cc[b + 91] / 128);   // 8.4.8: linear unipolar CC91 x 200
      if (cc[b + 93] !== 0) d[15] += 200 * (cc[b + 93] / 128);   // 8.4.9: linear unipolar CC93 x 200
    }
    const mods = v.mods;
    if (!mods) return;
    const ch = this.chans[c];
    const inp = this.inputs;
    inp.velocity = v.effVel; inp.key = v.effKey; inp.ccBase = c * 128;
    inp.pitchWheel = ch.bend; inp.pitchWheelSensitivity = ch.pws; inp.channelPressure = ch.pressure;
    inp.polyPressure = v.note >= 0 && v.note < 128 ? this.poly[c * 128 + v.note] : 0;
    for (let k = 0; k < mods.length; k++) {
      const m = mods[k];
      d[m.dest] += modValue(m, inp);
    }
  }

  private applyLive(v: Sf2Voice, d: Float64Array): void {
    const qCb = Math.max(0, Math.min(960, v.regQ + d[9]));
    // G-08: Q cB above DC; DC gain reduced by Q/2; RBJ q from peak/DC ratio G = 10^(Q/200).
    const gq = Math.pow(10, qCb / 200);
    const q = Math.sqrt((gq * gq + gq * Math.sqrt(gq * gq - 1)) / 2);
    if (q !== v.lpf.q) { v.lpf.q = q; v.lastFc = NaN; }
    v.qCb = qCb;
    const filterGain = Math.pow(10, -qCb / 400);
    v.baseGain = cbAttenToLin(Math.max(0, Math.min(1440, v.regAtten + d[48]))) * filterGain;
    v.regionPanPos = Math.max(-500, Math.min(500, v.regPan + d[17])) / 500;
    v.initialFc = clampGen(8, v.regFc + d[8]);
    if (v.lastFc !== v.initialFc) v.lastFc = NaN;
    v.vibToPitch = clampGen(6, v.regVib + d[6]);
    v.modToPitch = clampGen(5, v.regModPitch + d[5]);
    v.modEnvToPitch = clampGen(7, v.regModEnvPitch + d[7]);
    v.modLfoToFc = clampGen(10, v.regModLfoFc + d[10]);
    v.modEnvToFc = clampGen(11, v.regModEnvFc + d[11]);
    v.modLfoToVol = clampGen(13, v.regModLfoVol + d[13]);
    v.chorusAmt = clampGen(15, v.regChorus + d[15]) / 1000;
    v.reverbAmt = clampGen(16, v.regReverb + d[16]) / 1000;
    const pitch = d[PITCH_DEST] + d[51] * 100 + d[52];
    v.baseRate = pitch === 0 ? v.baseRate0 : v.baseRate0 * centsToRatio(pitch);
    v.rate = v.baseRate;
  }

  private specVoice(v: Sf2Voice, reg: SF2Region, note: number, trackGain: number): void {
    const mods = reg.modulators === undefined || reg.modulators === null ? DEFAULT_MODS_204 : reg.modulators;
    v.mods = mods.length > 0 ? mods : null;
    let sendMods = false;
    for (let k = 0; k < mods.length; k++) { const m = mods[k]; if ((m.dest === 15 || m.dest === 16) && (m.src & 0x80) && ((m.src & 0x7f) === 91 || (m.src & 0x7f) === 93)) sendMods = true; }
    v.hasSendMods = sendMods;
    v.regAtten = reg.initialAttenuationCb; v.regPan = reg.pan;
    v.regFc = reg.initialFilterFcCents; v.regQ = reg.initialFilterQCb;
    v.regVib = reg.vibLfoToPitchCents; v.regModPitch = reg.modLfoToPitchCents;
    v.regModEnvPitch = reg.modEnvToPitchCents ?? 0;
    v.regModLfoFc = reg.modLfoToFilterFcCents; v.regModEnvFc = reg.modEnvToFilterFcCents;
    v.regModLfoVol = reg.modLfoToVolumeCb ?? 0;
    v.regChorus = reg.chorusSend ?? 0; v.regReverb = reg.reverbSend ?? 0;
    // MIDI-04 soft pedal at note-on: +60 cB, -600 cents cutoff (engine choice).
    if (this.ccs[Math.max(0, Math.min(15, v.channel)) * 128 + 67] >= 64) {   // CC67 soft pedal (MIDI 1.0)
      v.regAtten += Sf2SynthEngine.softPedalAttenuationCb; v.regFc -= Sf2SynthEngine.softPedalFcCents;
    }
    v.baseRate0 = v.baseRate;
    v.trackGain = trackGain;
    v.trackVolumeMul = Math.max(0, trackGain);
    v.trackVolumeMul = trackGain;
    const d = this.scratch;
    this.evalMods(v, d);
    const keyDelta = 60 - note;
    const tc = (base: number, add: number, id: number) => roundHalfAway(clampGen(id, base + add));
    const kVH = clampGen(39, (reg.keynumToVolEnvHold ?? 0) + d[39]), kVD = clampGen(40, (reg.keynumToVolEnvDecay ?? 0) + d[40]);
    const kMH = clampGen(31, (reg.keynumToModEnvHold ?? 0) + d[31]), kMD = clampGen(32, (reg.keynumToModEnvDecay ?? 0) + d[32]);
    const e = reg.volEnv;
    VE.delayTc = tc(e.delayTc, d[33], 33); VE.attackTc = tc(e.attackTc, d[34], 34);
    VE.holdTc = tc(e.holdTc, d[35], 35) + roundHalfAway(kVH * keyDelta);
    VE.decayTc = tc(e.decayTc, d[36], 36) + roundHalfAway(kVD * keyDelta);
    VE.sustainCb = tc(e.sustainCb, d[37], 37); VE.releaseTc = tc(e.releaseTc, d[38], 38);
    v.volEnv.setFromSf2(VE);
    const m = reg.modEnv;
    ME.delayTc = tc(m.delayTc, d[25], 25); ME.attackTc = tc(m.attackTc, d[26], 26);
    ME.holdTc = tc(m.holdTc, d[27], 27) + roundHalfAway(kMH * keyDelta);
    ME.decayTc = tc(m.decayTc, d[28], 28) + roundHalfAway(kMD * keyDelta);
    ME.sustain = Math.max(0, Math.min(1, m.sustain - d[29] / 1000)); ME.releaseTc = tc(m.releaseTc, d[30], 30);
    v.modEnv.setFromSf2(ME);
    // G-06: LFO frequency clamped to 1 mHz ... 100 Hz.
    v.modLfo.set(Math.max(0.001, Math.min(100, fcCentsToHz(clampGen(22, reg.modLfoFreqCents + d[22])))),
      timecentsToSeconds(clampGen(21, reg.modLfoDelayTc + d[21])));
    v.vibLfo.set(Math.max(0.001, Math.min(100, fcCentsToHz(clampGen(24, reg.vibLfoFreqCents + d[24])))),
      timecentsToSeconds(clampGen(23, reg.vibLfoDelayTc + d[23])));
    // G-13: scaleTuning is non-real-time: modulators apply at note-on only.
    if (d[Gen.scaleTuning] !== 0) {
      const st0 = reg.scaleTuning, st1 = clampGen(56, st0 + d[56]);
      const root = reg.overridingRootKey ?? reg.originalKey;
      v.baseRate *= centsToRatio((note - root) * (st1 - st0));
      v.baseRate0 = v.baseRate;
    }
    this.applyLive(v, d);
    v.lpf.setCutoffHz(fcCentsToHz(v.initialFc));
    v.lastFc = v.initialFc;
  }

  /** N-05 (9.6.3): span halved until <= 8192, so each data step is 2^k native units. */
  static nrpnScale(gen: number): number {
    const r = valueRange(gen);
    if (!r) return 0;
    let span = r[1] - r[0], step = 1;
    while (span > 8192) { span /= 2; step *= 2; }
    return step;
  }

  private updateChannelVoices(channel: number): void {
    const d = this.scratch;
    for (let i = 0; i < this.count; i++) {
      const v = this.pool[this.order[i]];
      if (v.channel !== channel) continue;
      this.evalMods(v, d);
      this.applyLive(v, d);
    }
  }

  private controlChange(channel: number, cc: number, value: number): void {
    const ch = this.chans[channel];
    const base = channel * 128;
    const ccs = this.ccs;
    const old = ccs[base + cc];
    ccs[base + cc] = value;
    switch (cc) {
      case 101: ch.rpnMsb = value; ch.paramIsNRPN = false; break;
      case 100: ch.rpnLsb = value; ch.paramIsNRPN = false; break;
      case 99:
        ch.rpnMsb = 127; ch.rpnLsb = 127; ch.paramIsNRPN = true;
        ch.nrpnActive = value === 120;      // N-01
        ch.nrpnAccum = 0;
        break;
      case 98:
        ch.rpnMsb = 127; ch.rpnLsb = 127; ch.paramIsNRPN = true;
        if (!ch.nrpnActive) break;
        if (value <= 99) {                   // N-02 / N-03
          const gen = ch.nrpnAccum + value;
          ch.nrpnAccum = 0;
          if (gen < 61 && valueRangeExists(gen) && gen !== Gen.scaleTuning) ch.nrpnSelect = gen;
        } else if (value === 100) ch.nrpnAccum += 100;
        else if (value === 101) ch.nrpnAccum += 1000;
        else if (value === 102) ch.nrpnAccum += 10000;
        break;
      case 6:
        if (ch.paramIsNRPN) {
          if (ch.nrpnActive && ch.nrpnSelect >= 0) {   // N-04
            const g = ch.nrpnSelect;
            const v = ((value << 7) | ccs[base + 38]) - 8192;
            this.nrpn[channel * 64 + g] = v * Sf2SynthEngine.nrpnScale(g);
          }
        } else if (ch.rpnMsb === 0 && ch.rpnLsb === 0) {
          ch.pws = value + ccs[base + 38] / 100;
        }
        break;
      case 38:
        if (!ch.paramIsNRPN && ch.rpnMsb === 0 && ch.rpnLsb === 0) ch.pws = ccs[base + 6] + value / 100;
        break;
      case 64:
        if (value < 64 && old >= 64) this.releaseDeferred(channel);   // MIDI-02
        break;
      case 66:                                                          // MIDI-03 CC66 sostenuto (MIDI 1.0)
        if (value >= 64 && !ch.sostenuto) {
          ch.sostenuto = true;
          for (let i = 0; i < this.count; i++) {
            const v = this.pool[this.order[i]];
            if (v.channel === channel && v.keyDown) v.sostenuto = true;
          }
        } else if (value < 64 && ch.sostenuto) {
          ch.sostenuto = false;
          for (let i = 0; i < this.count; i++) {
            const v = this.pool[this.order[i]];
            if (v.channel === channel) v.sostenuto = false;
          }
          this.releaseDeferred(channel);
        }
        break;
      case 120:                                                         // MIDI-05 all sound off
        for (let i = 0; i < this.count; i++) {
          const v = this.pool[this.order[i]];
          if (v.channel === channel) { v.volEnv.kill(); v.finished = true; }
        }
        return;
      case 123:                                                         // MIDI-05 all notes off
        for (let i = 0; i < this.count; i++) {
          const v = this.pool[this.order[i]];
          if (v.channel === channel && v.keyDown) this.keyOffVoice(v);
        }
        break;
      case 121: {                                                       // MIDI-06 / N-06
        for (const k of [1, 2, 4, 64, 65, 66, 67, 68, 69]) ccs[base + k] = 0;
        ccs[base + 11] = 127; ccs[base + 100] = 127; ccs[base + 101] = 127; ccs[base + 98] = 127; ccs[base + 99] = 127;
        ch.rpnMsb = 127; ch.rpnLsb = 127; ch.bend = 8192; ch.pressure = 0;
        ch.paramIsNRPN = false; ch.nrpnActive = false; ch.nrpnSelect = -1; ch.nrpnAccum = 0; ch.sostenuto = false;
        this.nrpn.fill(0, channel * 64, channel * 64 + 64);
        this.poly.fill(0, base, base + 128);
        for (let i = 0; i < this.count; i++) {
          const v = this.pool[this.order[i]];
          if (v.channel === channel) v.sostenuto = false;
        }
        this.releaseDeferred(channel);
        break;
      }
      default: break;
    }
    this.updateChannelVoices(channel);
  }

  private advancePos(v: Sf2Voice): void {
    v.pos += v.rate;
    if (v.looping && !v.inReleaseTail) {
      if (v.pos >= v.loopEnd) {
        const loopLen = v.loopEnd - v.loopStart;
        v.pos = loopLen > 1 ? v.loopStart + ((v.pos - v.loopStart) % loopLen) : v.loopStart;
      }
      return;
    }
    if (v.pos >= v.end || !Number.isFinite(v.pos)) v.finished = true;
  }

  /** One output frame into frameL / frameR (sends accumulate into the bus sums). */
  private renderFrame(): void {
    let sumL = 0, sumR = 0;
    const bypassHz = Math.min(20000, 0.45 * this.outSr);
    for (let vi = this.count - 1; vi >= 0; vi--) {
      const v = this.pool[this.order[vi]];
      if (v.finished || v.volEnv.stage === IDLE) { this.removeVoice(vi); continue; }
      const modEnv = v.modEnv.next();
      const modLfo = v.modLfo.next();
      const vibLfo = v.vibLfo.next();
      let pitchCents = vibLfo * v.vibToPitch + modLfo * v.modToPitch;
      if (v.modEnvToPitch !== 0) pitchCents += modEnv * v.modEnvToPitch;
      v.rate = pitchCents === 0 ? v.baseRate : v.baseRate * centsToRatio(pitchCents);
      const sL = readSampleMono(v.dataL, v.pos);
      const sR = v.dataR ? readSampleMono(v.dataR, v.pos) : sL;
      const fcCents = v.initialFc + modEnv * v.modEnvToFc + modLfo * v.modLfoToFc;
      if (fcCents !== v.lastFc) { v.lpf.setCutoffHz(fcCentsToHz(fcCents)); v.lastFc = fcCents; }
      let fL: number, fR: number;
      if (v.qCb <= 0 && fcCentsToHz(fcCents) >= bypassHz) { fL = sL; fR = sR; }   // G-08 bypass
      else { fL = v.lpf.processL(sL); fR = v.lpf.processR(sR); }
      const env = v.volEnv.next();
      let gain = v.baseGain * env * v.trackVolumeMul;
      if (v.modLfoToVol !== 0) gain *= cbAttenToLin(-modLfo * v.modLfoToVol);
      const mixPan = Math.max(-1, Math.min(1, v.regionPanPos + (v.trackIndex < 0 ? 0 : v.trackPanPos)));
      if (mixPan !== v.lastMixPan) {
        // G-10: linear amplitude law.
        v.gL = (1 - mixPan) * 0.5;
        v.gR = (1 + mixPan) * 0.5;
        v.lastMixPan = mixPan;
      }
      const oL = fL * gain * v.gL, oR = fR * gain * v.gR;
      sumL += oL; sumR += oR;
      this.revL += oL * v.reverbAmt; this.revR += oR * v.reverbAmt;
      this.choL += oL * v.chorusAmt; this.choR += oR * v.chorusAmt;
      this.advancePos(v);
    }
    this.frameL = sumL; this.frameR = sumR;
  }

  /** Master output stage (non-normative; see docs/SF2_COMPLIANCE.md "Master bus"). */
  readonly master: MasterBus;
  /** Master-bus dynamics (compressor, limiter, safety clip). The default is on. masterGainDb applies either way. */
  masterDynamicsEnabled = true;
  private masterGainLin = Math.pow(10, MASTER_GAIN_DEFAULT_DB / 20);
  private masterGainDbValue = MASTER_GAIN_DEFAULT_DB;
  /** Master gain in dB. The default is -3 dB. */
  get masterGainDb(): number { return this.masterGainDbValue; }
  set masterGainDb(db: number) { this.masterGainDbValue = db; this.masterGainLin = Math.pow(10, db / 20); }

  private applyMaster(): void {
    const l = this.frameL * this.masterGainLin, r = this.frameR * this.masterGainLin;
    if (this.masterDynamicsEnabled) { this.master.process(l, r); this.frameL = this.master.outL; this.frameR = this.master.outR; }
    else { this.frameL = l; this.frameR = r; }
  }

  private mixSends(): void {
    if (this.effectsEnabled) {
      this.fx.process(this.revL, this.revR, this.choL, this.choR);
      this.frameL += this.fx.outL; this.frameR += this.fx.outR;
    }
    this.revL = 0; this.revR = 0; this.choL = 0; this.choR = 0;
  }

  /** Overwrites every frame of outL / outR. */
  renderRange(outL: Float32Array, outR: Float32Array): void {
    const n = Math.min(outL.length, outR.length);
    for (let i = 0; i < n; i++) {
      this.renderFrame();
      this.mixSends();
      this.applyMaster();
      outL[i] = this.frameL;
      outR[i] = this.frameR;
    }
  }

  /** G-11 aux-bus render: dry mix plus the pre-effect send buses (built-in effects not applied). */
  renderRangeWithSends(outL: Float32Array, outR: Float32Array, reverbL: Float32Array, reverbR: Float32Array,
    chorusL: Float32Array, chorusR: Float32Array): void {
    const n = Math.min(outL.length, outR.length, reverbL.length, reverbR.length, chorusL.length, chorusR.length);
    for (let i = 0; i < n; i++) {
      this.renderFrame();
      outL[i] = this.frameL; outR[i] = this.frameR;
      reverbL[i] = this.revL; reverbR[i] = this.revR; chorusL[i] = this.choL; chorusR[i] = this.choR;
      this.revL = 0; this.revR = 0; this.choL = 0; this.choR = 0;
    }
  }

  /** AudioWorklet path: dispatches events whose frame <= renderedSamples (events without a frame never fire). */
  renderScheduled(outL: Float32Array, outR: Float32Array, events: SynthEvent[], eventIndex = 0,
    renderedSamples = 0): { eventIndex: number; renderedSamples: number } {
    const n = Math.min(outL.length, outR.length);
    for (let i = 0; i < n; i++) {
      while (eventIndex < events.length && ev(events[eventIndex].frame, Infinity) <= renderedSamples) {
        this.dispatchEvent(events[eventIndex]);
        eventIndex += 1;
      }
      this.renderFrame();
      this.mixSends();
      this.applyMaster();
      outL[i] = this.frameL;
      outR[i] = this.frameR;
      renderedSamples += 1;
    }
    return { eventIndex, renderedSamples };
  }
}

const VE: SF2VolEnv = { delayTc: 0, attackTc: 0, holdTc: 0, decayTc: 0, sustainCb: 0, releaseTc: 0 };
const ME: SF2ModEnv = { delayTc: 0, attackTc: 0, holdTc: 0, decayTc: 0, sustain: 0, releaseTc: 0 };
function valueRangeExists(gen: number): boolean { return valueRange(gen) !== null; }

// ── Offline renderers ─────────────────────────────────────────────────────────

/** Offline event order: (frame ?? 0, seq ?? 0, trackIndex ?? 0), stable. */
export function sortEvents(events: SynthEvent[]): SynthEvent[] {
  return Array.isArray(events)
    ? events.map((e, i) => [e, i] as const).sort(([a, ia], [b, ib]) =>
      ((a.frame ?? 0) - (b.frame ?? 0)) || ((a.seq ?? 0) - (b.seq ?? 0)) || ((a.trackIndex ?? 0) - (b.trackIndex ?? 0)) || ia - ib)
      .map(([e]) => e)
    : [];
}

/** Renders tracks + events into Float32 stereo buffers of `length` frames. */
export function renderOfflineSequence(sampleRate: number, length: number, tracks: TrackState[], events: SynthEvent[],
  maxVoices = 64): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(length), right = new Float32Array(length);
  const engine = new Sf2SynthEngine(sampleRate, { maxVoices });
  engine.setTrackStates(tracks);
  let cursor = 0;
  for (const e of sortEvents(events)) {
    const frame = Math.max(0, Math.min(length, (e.frame ?? 0) | 0));
    if (frame > cursor) { engine.renderRange(left.subarray(cursor, frame), right.subarray(cursor, frame)); cursor = frame; }
    engine.dispatchEvent(e);
  }
  if (cursor < length) engine.renderRange(left.subarray(cursor), right.subarray(cursor));
  return { left, right };
}

export interface RenderOfflineParams { audioBuffer: AudioBuffer; tracks: TrackState[]; events: SynthEvent[]; maxVoices?: number }
export interface RenderOfflineIncrementalParams extends RenderOfflineParams { chunkFrames?: number; onProgress?: (progress: number) => void }

export function renderOfflineSequenceToAudioBuffer({ audioBuffer, tracks, events, maxVoices = 64 }: RenderOfflineParams): AudioBuffer {
  const { left, right } = renderOfflineSequence(audioBuffer.sampleRate, audioBuffer.length, tracks, events, maxVoices);
  audioBuffer.getChannelData(0).set(left);
  if (audioBuffer.numberOfChannels > 1) audioBuffer.getChannelData(1).set(right);
  return audioBuffer;
}

function yieldToBrowser(): Promise<void> { return new Promise((resolve) => { setTimeout(resolve, 0); }); }

export async function renderOfflineSequenceToAudioBufferIncremental({
  audioBuffer, tracks, events, maxVoices = 64, chunkFrames = 8192, onProgress,
}: RenderOfflineIncrementalParams): Promise<AudioBuffer> {
  const outL = audioBuffer.getChannelData(0);
  const outR = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : new Float32Array(audioBuffer.length);
  const engine = new Sf2SynthEngine(audioBuffer.sampleRate, { maxVoices });
  engine.setTrackStates(tracks);
  const sorted = sortEvents(events);
  const total = audioBuffer.length;
  let cursor = 0, ei = 0;
  while (cursor < total || ei < sorted.length) {
    const chunkEnd = Math.min(total, cursor + chunkFrames);
    while (ei < sorted.length) {
      const frame = Math.max(0, Math.min(total, (sorted[ei].frame ?? 0) | 0));
      if (frame > chunkEnd || (frame === chunkEnd && chunkEnd < total)) break;
      if (frame > cursor) { engine.renderRange(outL.subarray(cursor, frame), outR.subarray(cursor, frame)); cursor = frame; }
      engine.dispatchEvent(sorted[ei++]);
    }
    if (chunkEnd > cursor) { engine.renderRange(outL.subarray(cursor, chunkEnd), outR.subarray(cursor, chunkEnd)); cursor = chunkEnd; }
    onProgress?.(total ? cursor / total : 1);
    if (cursor >= total && ei >= sorted.length) break;
    if (cursor >= total) { while (ei < sorted.length) engine.dispatchEvent(sorted[ei++]); break; }
    await yieldToBrowser();
  }
  return audioBuffer;
}
