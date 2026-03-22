import type { SF2Region } from "../sf2-parser.ts";

// ── Envelope stage ────────────────────────────────────────────────────────────

export type EnvStage =
  | "idle"
  | "delay"
  | "attack"
  | "hold"
  | "decay"
  | "sustain"
  | "release";

// ── Envelope parameter shapes (all optional so SF2VolEnv/SF2ModEnv are assignable) ──

export interface VolEnvParams {
  delayTc?: number;
  attackTc?: number;
  holdTc?: number;
  decayTc?: number;
  sustainCb?: number;
  releaseTc?: number;
}

export interface ModEnvParams {
  delayTc?: number;
  attackTc?: number;
  holdTc?: number;
  decayTc?: number;
  sustain?: number;
  releaseTc?: number;
}

// ── Public data-transfer shapes ───────────────────────────────────────────────

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

/** Generic synth event sent to the engine (covers all message sub-types). */
export interface SynthEvent {
  type: string;
  frame?: number;
  seq?: number;
  trackIndex?: number | null;
  note?: number;
  velocity?: number;
  regions?: SF2Region[];
  channel?: number;
  cc7Volume?: number;
  cc10Pan?: number;
  cc11Expression?: number;
  pan?: number;
  gain?: number;
  /** Used by the AudioWorklet processor for setOfflineTracks. */
  tracks?: TrackState[];
  /** Used by the AudioWorklet processor for setOfflineTracks. */
  maxVoices?: number;
  /** Used by the AudioWorklet processor for setSequence. */
  events?: SynthEvent[];
}

// ── Helper constants / functions ──────────────────────────────────────────────

function timecentsToSeconds(tc: number): number {
  return Math.pow(2, (tc ?? 0) / 1200);
}

function centsToRatio(c: number): number {
  return Math.pow(2, (c ?? 0) / 1200);
}

function cbAttenToLin(cb: number): number {
  const db = -(cb ?? 0) / 10;
  return Math.pow(10, db / 20);
}

function velToLin(vel: number, curve = 2.0): number {
  const x = Math.max(0, Math.min(127, vel)) / 127;
  return Math.pow(x, curve);
}

function balanceToGains(balance: number): { gL: number; gR: number } {
  const p = Math.max(-1, Math.min(1, balance ?? 0));
  const angle = (p + 1) * 0.25 * Math.PI;
  return { gL: Math.cos(angle), gR: Math.sin(angle) };
}

function fcCentsToHz(fcCents: number): number {
  return 8.176 * Math.pow(2, (fcCents ?? 13500) / 1200);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

const MIN_VOL_RELEASE_SEC = 0.06;
const MIN_MOD_RELEASE_SEC = 0.02;

// ── VolEnv ────────────────────────────────────────────────────────────────────

class VolEnv {
  sr: number;
  stage: EnvStage;
  level: number;
  t: number;
  peak: number;
  delay: number;
  attack: number;
  hold: number;
  decay: number;
  sustain: number;
  release: number;
  releaseStart: number;

  constructor(sr: number) {
    this.sr = sr;
    this.stage = "idle";
    this.level = 0;
    this.t = 0;
    this.peak = 1.0;
    this.delay = 0;
    this.attack = 0.01;
    this.hold = 0;
    this.decay = 0.1;
    this.sustain = 0.5;
    this.release = 0.2;
    this.releaseStart = 0;
  }

  setFromSf2({ delayTc, attackTc, holdTc, decayTc, sustainCb, releaseTc }: VolEnvParams): void {
    this.delay = Math.max(0, timecentsToSeconds(delayTc ?? -12000));
    this.attack = Math.max(0, timecentsToSeconds(attackTc ?? -12000));
    this.hold = Math.max(0, timecentsToSeconds(holdTc ?? -12000));
    this.decay = Math.max(0, timecentsToSeconds(decayTc ?? -12000));
    this.release = Math.max(MIN_VOL_RELEASE_SEC, timecentsToSeconds(releaseTc ?? 0));
    const sustainDb = -(sustainCb ?? 0) / 10;
    this.sustain = Math.min(1, Math.max(0, Math.pow(10, sustainDb / 20)));
  }

  noteOn(): void {
    this.stage = this.delay > 0 ? "delay" : "attack";
    this.t = 0;
    this.level = 0;
  }

  noteOff(): void {
    if (this.stage === "idle") return;
    this.stage = "release";
    this.t = 0;
    this.releaseStart = this.level;
  }

  next(): number {
    const dt = 1 / this.sr;
    const eps = 1e-5;

    switch (this.stage) {
      case "idle":
        this.level = 0;
        return 0;
      case "delay":
        this.t += dt;
        if (this.t >= this.delay) {
          this.stage = "attack";
          this.t = 0;
        }
        this.level = 0;
        return 0;
      case "attack": {
        if (this.attack <= 0) {
          this.level = this.peak;
          this.stage = this.hold > 0 ? "hold" : "decay";
          this.t = 0;
          return this.level;
        }
        this.t += dt;
        const x = Math.min(1, this.t / this.attack);
        this.level = this.peak * (1 - Math.exp(-x * 6));
        if (x >= 1) {
          this.level = this.peak;
          this.stage = this.hold > 0 ? "hold" : "decay";
          this.t = 0;
        }
        return this.level;
      }
      case "hold":
        this.t += dt;
        this.level = this.peak;
        if (this.t >= this.hold) {
          this.stage = "decay";
          this.t = 0;
        }
        return this.level;
      case "decay": {
        if (this.decay <= 0) {
          this.level = this.sustain;
          this.stage = "sustain";
          this.t = 0;
          return this.level;
        }
        this.t += dt;
        const x = Math.min(1, this.t / this.decay);
        const start = Math.max(eps, this.peak);
        const end = Math.max(eps, this.sustain);
        this.level = Math.exp(Math.log(start) + (Math.log(end) - Math.log(start)) * x);
        if (x >= 1) {
          this.level = this.sustain;
          this.stage = "sustain";
          this.t = 0;
        }
        return this.level;
      }
      case "sustain":
        this.level = this.sustain;
        return this.level;
      case "release": {
        if (this.release <= 0) {
          this.level = 0;
          this.stage = "idle";
          return 0;
        }
        this.t += dt;
        const x = Math.min(1, this.t / this.release);
        const start = Math.max(eps, this.releaseStart);
        this.level = Math.exp(Math.log(start) + (Math.log(eps) - Math.log(start)) * x);
        if (x >= 1) {
          this.level = 0;
          this.stage = "idle";
        }
        return this.level;
      }
      default:
        return 0;
    }
  }
}

// ── ModEnv ────────────────────────────────────────────────────────────────────

class ModEnv {
  sr: number;
  stage: EnvStage;
  level: number;
  t: number;
  delay: number;
  attack: number;
  hold: number;
  decay: number;
  sustain: number;
  release: number;
  releaseStart: number;

  constructor(sr: number) {
    this.sr = sr;
    this.stage = "idle";
    this.level = 0;
    this.t = 0;
    this.delay = 0;
    this.attack = 0.01;
    this.hold = 0;
    this.decay = 0.1;
    this.sustain = 0;
    this.release = 0.2;
    this.releaseStart = 0;
  }

  setFromSf2({ delayTc, attackTc, holdTc, decayTc, sustain, releaseTc }: ModEnvParams): void {
    this.delay = Math.max(0, timecentsToSeconds(delayTc ?? -12000));
    this.attack = Math.max(0, timecentsToSeconds(attackTc ?? -12000));
    this.hold = Math.max(0, timecentsToSeconds(holdTc ?? -12000));
    this.decay = Math.max(0, timecentsToSeconds(decayTc ?? -12000));
    this.release = Math.max(MIN_MOD_RELEASE_SEC, timecentsToSeconds(releaseTc ?? 0));
    this.sustain = Math.min(1, Math.max(0, sustain ?? 0));
  }

  noteOn(): void {
    this.stage = this.delay > 0 ? "delay" : "attack";
    this.t = 0;
    this.level = 0;
  }

  noteOff(): void {
    if (this.stage === "idle") return;
    this.stage = "release";
    this.t = 0;
    this.releaseStart = this.level;
  }

  next(): number {
    const dt = 1 / this.sr;

    switch (this.stage) {
      case "idle":
        this.level = 0;
        return 0;
      case "delay":
        this.t += dt;
        if (this.t >= this.delay) {
          this.stage = "attack";
          this.t = 0;
        }
        this.level = 0;
        return 0;
      case "attack": {
        if (this.attack <= 0) {
          this.level = 1;
          this.stage = this.hold > 0 ? "hold" : "decay";
          this.t = 0;
          return this.level;
        }
        this.t += dt;
        const x = Math.min(1, this.t / this.attack);
        this.level = x;
        if (x >= 1) {
          this.level = 1;
          this.stage = this.hold > 0 ? "hold" : "decay";
          this.t = 0;
        }
        return this.level;
      }
      case "hold":
        this.t += dt;
        this.level = 1;
        if (this.t >= this.hold) {
          this.stage = "decay";
          this.t = 0;
        }
        return this.level;
      case "decay": {
        if (this.decay <= 0) {
          this.level = this.sustain;
          this.stage = "sustain";
          this.t = 0;
          return this.level;
        }
        this.t += dt;
        const x = Math.min(1, this.t / this.decay);
        this.level = lerp(1, this.sustain, x);
        if (x >= 1) {
          this.level = this.sustain;
          this.stage = "sustain";
          this.t = 0;
        }
        return this.level;
      }
      case "sustain":
        this.level = this.sustain;
        return this.level;
      case "release": {
        if (this.release <= 0) {
          this.level = 0;
          this.stage = "idle";
          return 0;
        }
        this.t += dt;
        const x = Math.min(1, this.t / this.release);
        this.level = lerp(this.releaseStart, 0, x);
        if (x >= 1) {
          this.level = 0;
          this.stage = "idle";
        }
        return this.level;
      }
      default:
        return 0;
    }
  }
}

// ── LFO ───────────────────────────────────────────────────────────────────────

class LFO {
  sr: number;
  phase: number;
  freqHz: number;
  delayLeft: number;

  constructor(sr: number) {
    this.sr = sr;
    this.phase = 0;
    this.freqHz = 5;
    this.delayLeft = 0;
  }

  set(freqHz: number, delaySec: number): void {
    this.freqHz = Math.max(0, freqHz ?? 0);
    this.delayLeft = Math.max(0, delaySec ?? 0);
  }

  next(): number {
    if (this.delayLeft > 0) {
      this.delayLeft -= 1 / this.sr;
      return 0;
    }
    this.phase += (2 * Math.PI * this.freqHz) / this.sr;
    if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
    return Math.sin(this.phase);
  }
}

// ── TwoPoleLPF ────────────────────────────────────────────────────────────────

class TwoPoleLPF {
  sr: number;
  z1L: number;
  z2L: number;
  z1R: number;
  z2R: number;
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;

  constructor(sr: number) {
    this.sr = sr;
    this.z1L = 0;
    this.z2L = 0;
    this.z1R = 0;
    this.z2R = 0;
    this.b0 = 1;
    this.b1 = 0;
    this.b2 = 0;
    this.a1 = 0;
    this.a2 = 0;
  }

  setCutoffHz(hz: number): void {
    const clamped = Math.max(5, Math.min(hz ?? 1000, this.sr * 0.45));
    const q = 0.7071;
    const w0 = (2 * Math.PI * clamped) / this.sr;
    const cosw0 = Math.cos(w0);
    const sinw0 = Math.sin(w0);
    const alpha = sinw0 / (2 * q);
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

// ── Voice ─────────────────────────────────────────────────────────────────────

interface Voice {
  note: number;
  channel: number;
  trackIndex: number | null;
  velocity: number;
  region: SF2Region;
  pos: number;
  baseRate: number;
  rate: number;
  start: number;
  end: number;
  loopStart: number;
  loopEnd: number;
  looping: boolean;
  loopUntilReleaseThenTail: boolean;
  inReleaseTail: boolean;
  dataL: Float32Array;
  dataR: Float32Array | null | undefined;
  baseGain: number;
  regionPanPos: number;
  trackPanPos: number;
  trackVolumeMul: number;
  volEnv: VolEnv;
  modEnv: ModEnv;
  modLfo: LFO;
  vibLfo: LFO;
  lpf: TwoPoleLPF;
  exclusiveClass: number;
  finished: boolean;
}

interface MakeVoiceOptions {
  channel?: number;
  trackIndex?: number | null;
  trackPanPos?: number;
  trackVolumeMul?: number;
}

// ── Internal per-track state (stored in Map) ───────────────────────────────────

interface InternalTrackState {
  regions: SF2Region[];
  cc7Volume: number;
  cc10Pan: number;
  cc11Expression: number;
  pan: number;
  gain: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function regionBaseRate(region: SF2Region, midiNote: number, outSr: number): number {
  const root = region.overridingRootKey ?? region.originalKey ?? 60;
  const scale = region.scaleTuning ?? 100;
  const keyTrackCents = (midiNote - root) * scale;
  const tuneCents = (region.coarseTune ?? 0) * 100 + (region.fineTune ?? 0);
  const srRatio = (region.sample.sampleRate ?? outSr) / outSr;
  return centsToRatio(keyTrackCents + tuneCents) * srRatio;
}

function readSampleMono(data: Float32Array, pos: number): number {
  const i = pos | 0;
  const f = pos - i;
  const a = data[i] ?? 0;
  const b = data[i + 1] ?? 0;
  return a + (b - a) * f;
}

function makeVoice(
  region: SF2Region,
  note: number,
  velocity: number,
  outSr: number,
  options: MakeVoiceOptions = {}
): Voice {
  const sample = region.sample;
  const start = sample.start ?? 0;
  const end = sample.end ?? sample.dataL.length;
  const loopStart = sample.loopStart ?? start;
  const loopEnd = sample.loopEnd ?? end;
  const sampleModes = region.sampleModes ?? 0;
  const looping = sampleModes === 1 || sampleModes === 3;
  const loopUntilReleaseThenTail = sampleModes === 3;

  const voice: Voice = {
    note,
    channel: options.channel ?? 0,
    trackIndex: options.trackIndex ?? null,
    velocity,
    region,
    pos: start,
    baseRate: regionBaseRate(region, note, outSr),
    rate: regionBaseRate(region, note, outSr),
    start,
    end,
    loopStart,
    loopEnd,
    looping,
    loopUntilReleaseThenTail,
    inReleaseTail: false,
    dataL: sample.dataL,
    dataR: sample.dataR,
    baseGain: velToLin(velocity, 2.0) * cbAttenToLin(region.initialAttenuationCb ?? 0),
    regionPanPos: Math.max(-500, Math.min(500, region.pan ?? 0)) / 500,
    trackPanPos: Math.max(-1, Math.min(1, options.trackPanPos ?? 0)),
    trackVolumeMul: Math.max(0, options.trackVolumeMul ?? 1),
    volEnv: new VolEnv(outSr),
    modEnv: new ModEnv(outSr),
    modLfo: new LFO(outSr),
    vibLfo: new LFO(outSr),
    lpf: new TwoPoleLPF(outSr),
    exclusiveClass: region.exclusiveClass ?? 0,
    finished: false,
  };

  voice.volEnv.setFromSf2(region.volEnv ?? {});
  voice.modEnv.setFromSf2(region.modEnv ?? {});
  voice.modLfo.set(centsToRatio(region.modLfoFreqCents ?? 0), timecentsToSeconds(region.modLfoDelayTc ?? -12000));
  voice.vibLfo.set(centsToRatio(region.vibLfoFreqCents ?? 0), timecentsToSeconds(region.vibLfoDelayTc ?? -12000));
  voice.lpf.setCutoffHz(fcCentsToHz(region.initialFilterFcCents ?? 13500));
  voice.volEnv.noteOn();
  voice.modEnv.noteOn();
  return voice;
}

// ── Sf2SynthEngine options ────────────────────────────────────────────────────

interface Sf2SynthEngineOptions {
  maxVoices?: number;
}

// ── Sf2SynthEngine ────────────────────────────────────────────────────────────

export class Sf2SynthEngine {
  outSr: number;
  regions: SF2Region[];
  voices: Voice[];
  maxVoices: number;
  cc7Volume: number;
  cc10Pan: number;
  cc11Expression: number;
  trackStates: Map<number, InternalTrackState>;

  constructor(outSr: number, options: Sf2SynthEngineOptions = {}) {
    this.outSr = outSr;
    this.regions = [];
    this.voices = [];
    this.maxVoices = Math.max(1, options.maxVoices ?? 64);
    this.cc7Volume = 100;
    this.cc10Pan = 64;
    this.cc11Expression = 127;
    this.trackStates = new Map();
  }

  setMaxVoices(maxVoices: number): void {
    this.maxVoices = Math.max(1, maxVoices ?? this.maxVoices);
  }

  setTrackStates(tracks: TrackState[]): void {
    this.trackStates = new Map(
      (tracks ?? []).map((track) => [
        track.trackIndex,
        {
          regions: track.regions ?? [],
          cc7Volume: Math.max(0, Math.min(127, track.cc7Volume ?? 100)),
          cc10Pan: Math.max(0, Math.min(127, track.cc10Pan ?? 64)),
          cc11Expression: Math.max(0, Math.min(127, track.cc11Expression ?? 127)),
          pan: Math.max(-1, Math.min(1, track.pan ?? 0)),
          gain: Math.max(0, track.gain ?? 1),
        },
      ])
    );
    this.voices.length = 0;
  }

  dispatchEvent(msg: SynthEvent): void {
    if (!msg) return;

    if (msg.type === "setPreset") {
      if (Number.isInteger(msg.trackIndex)) {
        const trackState = this.trackStates.get(msg.trackIndex as number);
        if (trackState) trackState.regions = msg.regions ?? [];
        return;
      }
      this.regions = msg.regions ?? [];
      this.voices.length = 0;
      return;
    }

    if (msg.type === "noteOn") {
      const note = (msg.note ?? 0) | 0;
      const velocity = (msg.velocity ?? 0) | 0;
      const trackState = Number.isInteger(msg.trackIndex)
        ? this.trackStates.get(msg.trackIndex as number)
        : null;
      const regions = trackState?.regions ?? this.regions;
      const matching = this.pickRegions(note, velocity, regions);
      if (!matching.length) return;

      for (const region of matching) {
        const excl = region.exclusiveClass ?? 0;
        if (excl) this.chokeExclusive(excl, msg.trackIndex ?? null);
      }

      const trackVolumeMul = trackState
        ? (trackState.cc7Volume / 127) * (trackState.cc11Expression / 127) * trackState.gain
        : 1;
      const trackPanPos = trackState ? (trackState.cc10Pan - 64) / 63 + trackState.pan : 0;

      for (const region of matching) {
        this.ensurePolyphony();
        this.voices.push(
          makeVoice(region, note, velocity, this.outSr, {
            channel: msg.channel ?? 0,
            trackIndex: msg.trackIndex ?? null,
            trackPanPos,
            trackVolumeMul,
          })
        );
      }
      return;
    }

    if (msg.type === "noteOff") {
      const note = (msg.note ?? 0) | 0;
      for (const voice of this.voices) {
        const sameTrack = msg.trackIndex == null || voice.trackIndex === msg.trackIndex;
        const sameChannel = msg.channel == null || voice.channel === msg.channel;
        if (voice.note === note && sameTrack && sameChannel) {
          voice.volEnv.noteOff();
          voice.modEnv.noteOff();
          if (voice.loopUntilReleaseThenTail) voice.inReleaseTail = true;
        }
      }
      return;
    }

    if (msg.type === "setControllers") {
      if (Number.isInteger(msg.trackIndex)) {
        const trackState = this.trackStates.get(msg.trackIndex as number);
        if (!trackState) return;
        if (Number.isFinite(msg.cc7Volume)) trackState.cc7Volume = Math.max(0, Math.min(127, (msg.cc7Volume as number) | 0));
        if (Number.isFinite(msg.cc10Pan)) trackState.cc10Pan = Math.max(0, Math.min(127, (msg.cc10Pan as number) | 0));
        if (Number.isFinite(msg.cc11Expression)) {
          trackState.cc11Expression = Math.max(0, Math.min(127, (msg.cc11Expression as number) | 0));
        }
        if (Number.isFinite(msg.pan)) trackState.pan = Math.max(-1, Math.min(1, msg.pan as number));
        if (Number.isFinite(msg.gain)) trackState.gain = Math.max(0, msg.gain as number);
        return;
      }
      if (Number.isFinite(msg.cc7Volume)) this.cc7Volume = Math.max(0, Math.min(127, (msg.cc7Volume as number) | 0));
      if (Number.isFinite(msg.cc10Pan)) this.cc10Pan = Math.max(0, Math.min(127, (msg.cc10Pan as number) | 0));
      if (Number.isFinite(msg.cc11Expression)) this.cc11Expression = Math.max(0, Math.min(127, (msg.cc11Expression as number) | 0));
    }
  }

  pickRegions(note: number, velocity: number, regions: SF2Region[] = this.regions): SF2Region[] {
    const out: SF2Region[] = [];
    for (const region of regions) {
      const [kl, kh] = region.keyRange ?? [0, 127];
      const [vl, vh] = region.velRange ?? [0, 127];
      if (note >= kl && note <= kh && velocity >= vl && velocity <= vh) out.push(region);
    }
    return out;
  }

  chokeExclusive(exclusiveClass: number, trackIndex: number | null = null): void {
    for (const voice of this.voices) {
      const sameTrack = trackIndex == null || voice.trackIndex === trackIndex;
      if (voice.exclusiveClass === exclusiveClass && sameTrack) {
        voice.volEnv.noteOff();
        voice.modEnv.noteOff();
        if (voice.loopUntilReleaseThenTail) voice.inReleaseTail = true;
      }
    }
  }

  ensurePolyphony(): void {
    if (this.voices.length < this.maxVoices) return;
    let minIdx = 0;
    let minVal = Infinity;
    for (let i = 0; i < this.voices.length; i += 1) {
      const voice = this.voices[i];
      const loudness = voice.volEnv.level * voice.baseGain;
      if (loudness < minVal) {
        minVal = loudness;
        minIdx = i;
      }
    }
    this.voices.splice(minIdx, 1);
  }

  advancePos(voice: Voice): void {
    voice.pos += voice.rate;
    const effectiveLooping = voice.looping && !voice.inReleaseTail;
    if (effectiveLooping) {
      if (voice.pos >= voice.loopEnd) {
        const loopLen = voice.loopEnd - voice.loopStart;
        voice.pos = loopLen > 1 ? voice.loopStart + ((voice.pos - voice.loopStart) % loopLen) : voice.loopStart;
      }
      return;
    }
    if (voice.pos >= voice.end) voice.finished = true;
  }

  renderRange(outL: Float32Array, outR: Float32Array): void {
    outL.fill(0);
    outR.fill(0);

    const volumeMul = (this.cc7Volume / 127) * (this.cc11Expression / 127);
    const ccPanPos = (this.cc10Pan - 64) / 63;

    for (let i = 0; i < outL.length; i += 1) {
      let sumL = 0;
      let sumR = 0;

      for (let vi = this.voices.length - 1; vi >= 0; vi -= 1) {
        const voice = this.voices[vi];
        if (voice.finished || voice.volEnv.stage === "idle") {
          this.voices.splice(vi, 1);
          continue;
        }

        const modEnv = voice.modEnv.next();
        const modLfo = voice.modLfo.next();
        const vibLfo = voice.vibLfo.next();
        const region = voice.region;
        const pitchCents =
          vibLfo * (region.vibLfoToPitchCents ?? 0) + modLfo * (region.modLfoToPitchCents ?? 0);
        voice.rate = voice.baseRate * centsToRatio(pitchCents);

        const sL = readSampleMono(voice.dataL, voice.pos);
        const sR = voice.dataR ? readSampleMono(voice.dataR, voice.pos) : sL;

        const fcCents =
          (region.initialFilterFcCents ?? 13500) +
          modEnv * (region.modEnvToFilterFcCents ?? 0) +
          modLfo * (region.modLfoToFilterFcCents ?? 0);
        voice.lpf.setCutoffHz(fcCentsToHz(fcCents));

        const fL = voice.lpf.processL(sL);
        const fR = voice.lpf.processR(sR);
        const env = voice.volEnv.next();
        const gain = voice.baseGain * env * (voice.trackVolumeMul ?? volumeMul);
        const mixPan = Math.max(
          -1,
          Math.min(1, voice.regionPanPos + (voice.trackIndex == null ? ccPanPos : voice.trackPanPos))
        );
        const panGains = balanceToGains(mixPan);

        sumL += fL * gain * panGains.gL;
        sumR += fR * gain * panGains.gR;
        this.advancePos(voice);
      }

      outL[i] = sumL;
      outR[i] = sumR;
    }
  }

  renderScheduled(
    outL: Float32Array,
    outR: Float32Array,
    events: SynthEvent[],
    eventIndex = 0,
    renderedSamples = 0
  ): { eventIndex: number; renderedSamples: number } {
    outL.fill(0);
    outR.fill(0);

    let nextEvent = events[eventIndex];
    const volumeMul = (this.cc7Volume / 127) * (this.cc11Expression / 127);
    const ccPanPos = (this.cc10Pan - 64) / 63;

    for (let i = 0; i < outL.length; i += 1) {
      let sumL = 0;
      let sumR = 0;

      while (nextEvent && (nextEvent.frame ?? Infinity) <= renderedSamples) {
        this.dispatchEvent(nextEvent);
        eventIndex += 1;
        nextEvent = events[eventIndex];
      }

      for (let vi = this.voices.length - 1; vi >= 0; vi -= 1) {
        const voice = this.voices[vi];
        if (voice.finished || voice.volEnv.stage === "idle") {
          this.voices.splice(vi, 1);
          continue;
        }

        const modEnv = voice.modEnv.next();
        const modLfo = voice.modLfo.next();
        const vibLfo = voice.vibLfo.next();
        const region = voice.region;
        const pitchCents =
          vibLfo * (region.vibLfoToPitchCents ?? 0) + modLfo * (region.modLfoToPitchCents ?? 0);
        voice.rate = voice.baseRate * centsToRatio(pitchCents);

        const sL = readSampleMono(voice.dataL, voice.pos);
        const sR = voice.dataR ? readSampleMono(voice.dataR, voice.pos) : sL;

        const fcCents =
          (region.initialFilterFcCents ?? 13500) +
          modEnv * (region.modEnvToFilterFcCents ?? 0) +
          modLfo * (region.modLfoToFilterFcCents ?? 0);
        voice.lpf.setCutoffHz(fcCentsToHz(fcCents));

        const fL = voice.lpf.processL(sL);
        const fR = voice.lpf.processR(sR);
        const env = voice.volEnv.next();
        const gain = voice.baseGain * env * (voice.trackVolumeMul ?? volumeMul);
        const mixPan = Math.max(
          -1,
          Math.min(1, voice.regionPanPos + (voice.trackIndex == null ? ccPanPos : voice.trackPanPos))
        );
        const panGains = balanceToGains(mixPan);

        sumL += fL * gain * panGains.gL;
        sumR += fR * gain * panGains.gR;
        this.advancePos(voice);
      }

      outL[i] = sumL;
      outR[i] = sumR;
      renderedSamples += 1;
    }

    return { eventIndex, renderedSamples };
  }
}

// ── Offline render parameter shapes ───────────────────────────────────────────

export interface RenderOfflineParams {
  audioBuffer: AudioBuffer;
  tracks: TrackState[];
  events: SynthEvent[];
  maxVoices?: number;
}

export interface RenderOfflineIncrementalParams {
  audioBuffer: AudioBuffer;
  tracks: TrackState[];
  events: SynthEvent[];
  maxVoices?: number;
  chunkFrames?: number;
  onProgress?: (progress: number) => void;
}

// ── Offline renderers ─────────────────────────────────────────────────────────

export function renderOfflineSequenceToAudioBuffer({
  audioBuffer,
  tracks,
  events,
  maxVoices = 64,
}: RenderOfflineParams): AudioBuffer {
  const outL = audioBuffer.getChannelData(0);
  const outR = audioBuffer.getChannelData(Math.min(1, audioBuffer.numberOfChannels - 1));
  const engine = new Sf2SynthEngine(audioBuffer.sampleRate, { maxVoices });
  engine.setTrackStates(tracks);

  const sortedEvents = Array.isArray(events)
    ? [...events].sort(
        (a, b) =>
          ((a.frame ?? 0) - (b.frame ?? 0)) ||
          ((a.seq ?? 0) - (b.seq ?? 0)) ||
          ((a.trackIndex ?? 0) - (b.trackIndex ?? 0))
      )
    : [];

  let cursor = 0;
  for (const event of sortedEvents) {
    const frame = Math.max(0, Math.min(audioBuffer.length, (event.frame ?? 0) | 0));
    if (frame > cursor) {
      engine.renderRange(outL.subarray(cursor, frame), outR.subarray(cursor, frame));
      cursor = frame;
    }
    engine.dispatchEvent(event);
  }

  if (cursor < audioBuffer.length) {
    engine.renderRange(outL.subarray(cursor), outR.subarray(cursor));
  }

  return audioBuffer;
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export async function renderOfflineSequenceToAudioBufferIncremental({
  audioBuffer,
  tracks,
  events,
  maxVoices = 64,
  chunkFrames = 8192,
  onProgress,
}: RenderOfflineIncrementalParams): Promise<AudioBuffer> {
  const outL = audioBuffer.getChannelData(0);
  const outR = audioBuffer.getChannelData(Math.min(1, audioBuffer.numberOfChannels - 1));
  const engine = new Sf2SynthEngine(audioBuffer.sampleRate, { maxVoices });
  engine.setTrackStates(tracks);

  const sortedEvents = Array.isArray(events)
    ? [...events].sort(
        (a, b) =>
          ((a.frame ?? 0) - (b.frame ?? 0)) ||
          ((a.seq ?? 0) - (b.seq ?? 0)) ||
          ((a.trackIndex ?? 0) - (b.trackIndex ?? 0))
      )
    : [];

  const totalFrames = audioBuffer.length;
  let cursor = 0;
  let eventIndex = 0;

  while (eventIndex < sortedEvents.length && (sortedEvents[eventIndex].frame ?? 0) <= 0) {
    engine.dispatchEvent(sortedEvents[eventIndex]);
    eventIndex += 1;
  }

  while (cursor < totalFrames) {
    const chunkEnd = Math.min(totalFrames, cursor + chunkFrames);
    let chunkCursor = cursor;

    while (chunkCursor < chunkEnd) {
      const nextEvent = sortedEvents[eventIndex];
      const nextEventFrame = nextEvent
        ? Math.max(0, Math.min(totalFrames, (nextEvent.frame ?? 0) | 0))
        : totalFrames;
      const renderEnd = Math.min(chunkEnd, nextEventFrame);

      if (renderEnd > chunkCursor) {
        engine.renderRange(outL.subarray(chunkCursor, renderEnd), outR.subarray(chunkCursor, renderEnd));
        chunkCursor = renderEnd;
      } else {
        chunkCursor = renderEnd;
      }

      while (eventIndex < sortedEvents.length) {
        const event = sortedEvents[eventIndex];
        const frame = Math.max(0, Math.min(totalFrames, (event.frame ?? 0) | 0));
        if (frame !== chunkCursor) break;
        engine.dispatchEvent(event);
        eventIndex += 1;
      }

      if (renderEnd === chunkEnd) break;
    }

    cursor = chunkEnd;
    onProgress?.(cursor / totalFrames);
    await yieldToBrowser();
  }

  return audioBuffer;
}
