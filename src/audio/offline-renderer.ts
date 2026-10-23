// Headless offline renderer: Project (the committed model, not player state) -> Sf2SynthEngine scheduled by
// absolute sample frame -> streaming WAV encode -> validation. No AudioContext, no user gesture, no player.
import { Sf2SynthEngine, type SynthEvent, type TrackState } from "../sf2-renderer.ts";
import type { Project } from "../workstation/model.ts";
import { bars, tempoSegments, type TempoSeg } from "../workstation/timing.ts";
import { normalizeEffects } from "../sf2/voice-overrides.ts";
import type { SF2SoundFont } from "../sf2/soundfont.ts";
import { loadSoundFont, resolveInstrument, type LoadedSoundFont, type ResolvedInstrument } from "./soundfont-loader.ts";
import { encodeChunk, wavDataBytes, wavHeader, type WavFormat } from "./wav-encoder.ts";
import { StatsAccumulator, validateWav, type AudioStats, type WavInfo } from "./audio-validation.ts";
import { RenderError, throwIfAborted, yieldToEventLoop } from "./render-error.ts";

export interface OfflineRenderOptions {
  sampleRate: 44100 | 48000;
  channels: 1 | 2;
  format: WavFormat;
  /** Seconds rendered after the last event for releases and reverb/chorus tails. Default 3. */
  tailSeconds?: number;
  /** Opt-in whole-file peak normalization to -1 dBFS (one gain for the entire file; CC dynamics preserved). */
  normalize?: boolean;
  startTick?: number; endTick?: number;
  /** Intentional silence: do not fail validation on an all-silent result. */
  allowSilence?: boolean;
  /** Peak (dBFS) at or below which the file counts as silent. Default -60. */
  silenceThresholdDbFS?: number;
  maxClippedFraction?: number;
  /** Hard limits (explicit RENDER_TOO_LARGE instead of exhausting memory). Defaults 40 min / 1.5 GiB. */
  maxSeconds?: number; maxBytes?: number;
  chunkFrames?: number;
}
export type RenderStage = "loading" | "resolving" | "rendering" | "encoding" | "validating";
export type ProgressFn = (progress: number, stage: RenderStage) => void;

export interface RenderResult {
  blob: Blob; bytes: Uint8Array; sha256: string; mimeType: "audio/wav";
  durationSeconds: number; musicSeconds: number; tailSeconds: number;
  sampleRate: number; channels: number; format: WavFormat; framesRendered: number; byteLength: number;
  peakDbFS: number; rmsDbFS: number; clippedSamples: number; gain: number; validated: true;
  wav: WavInfo; stats: AudioStats; instruments: InstrumentReport[]; warnings: string[]; soundFont: string;
  noteCount: number; renderMs: number;
}
export interface InstrumentReport { trackId: string; trackName: string; channel: number; presetName: string; bank: number; program: number; substituted: boolean; muted: boolean }

const CLS = { setup: 0, program: 1, cc: 2, ctl: 3, noteOff: 4, noteOn: 5 } as const;

function framer(p: Project, sr: number) {
  const segs: TempoSeg[] = tempoSegments(p.tempos, p.ppq);
  return (tick: number) => {
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (segs[m].tick <= tick) lo = m; else hi = m - 1; }
    const s = segs[lo];
    return Math.round((s.sec + ((tick - s.tick) * s.mpq) / 1e6 / p.ppq) * sr);
  };
}

/** End tick of the bar that contains `tick` (bar-aligned song end). */
export function barEnd(p: Project, tick: number): number {
  if (tick <= 0) return 0;
  const b = bars(p, tick).find((x) => x.tick + x.length >= tick);
  return b ? b.tick + b.length : tick;
}

export interface RenderPlan { tracks: TrackState[]; events: SynthEvent[]; startFrame: number; musicFrames: number; instruments: InstrumentReport[]; warnings: string[]; audibleNotes: number }

/** Project -> engine track states + frame-scheduled events (same controller semantics as realtime playback). */
export function buildRenderPlan(p: Project, sf: SF2SoundFont, sampleRate: number, range: { startTick?: number; endTick?: number } = {}): RenderPlan {
  const f = framer(p, sampleRate);
  const startTick = Math.max(0, range.startTick ?? 0);
  // Default range end: the end of the bar containing the last event (a 32-bar piece renders exactly 32 bars + tail).
  const lastTick = Math.max(p.endTick, ...p.notes.map((n) => n.tick + n.duration), 0);
  const endTick = range.endTick ?? barEnd(p, lastTick);
  const startFrame = f(startTick);
  const at = (tick: number) => Math.max(0, f(Math.max(tick, startTick)) - startFrame);
  const events: SynthEvent[] = []; let seq = 0;
  const push = (frame: number, cls: number, e: SynthEvent) => { e.frame = frame; e.seq = cls * 1e8 + seq++; events.push(e); };
  const warnings: string[] = []; const instruments: InstrumentReport[] = []; const tracks: TrackState[] = [];
  const anySolo = p.tracks.some((t) => t.mix.solo);
  let audibleNotes = 0;
  const effects = p.sound?.effects;
  if (effects) push(0, CLS.setup, { type: "setEffects", trackIndex: -1, effects: normalizeEffects(effects) });
  const resolved = new Map<string, ResolvedInstrument>();
  const res = (program: number, bank: number, ch: number) => {
    const k = `${program}:${bank}:${ch === 9}`;
    let r = resolved.get(k);
    if (!r) { r = resolveInstrument(sf, program, bank, ch); resolved.set(k, r); if (r.warning) warnings.push(r.warning); }
    return r;
  };
  p.tracks.forEach((t, ti) => {
    const muted = anySolo ? !t.mix.solo : t.mix.mute;
    const progs = p.programs.filter((g) => g.trackId === t.id).sort((a, b) => a.tick - b.tick);
    const initial = [...progs].reverse().find((g) => g.tick <= startTick);
    const ch0 = initial?.channel ?? t.channel;
    const inst = res(initial?.program ?? 0, initial?.bankMsb ?? 0, ch0);
    tracks.push({ trackIndex: ti, regions: inst.regions, pan: 0, gain: muted ? 0 : 1 });
    instruments.push({ trackId: t.id, trackName: t.name, channel: t.channel, presetName: inst.presetName, bank: inst.bank, program: inst.program, substituted: inst.substituted, muted });
    for (const g of progs) if (g.tick > startTick && g.tick < endTick) push(at(g.tick), CLS.program, { type: "setPreset", trackIndex: ti, regions: res(g.program, g.bankMsb, g.channel).regions });
    const ov = p.sound?.tracks[t.id];
    if (ov?.length) push(0, CLS.setup, { type: "setVoiceOverrides", trackIndex: ti, overrides: ov });
    // Mix defaults are the base layer under authored automation (same as the realtime controllerStateAt).
    const chans = new Set<number>([t.channel]);
    for (const n of p.notes) if (n.trackId === t.id) chans.add(n.channel);
    for (const ch of chans) {
      push(0, CLS.setup, { type: "controlChange", trackIndex: ti, channel: ch, controller: 7, value: t.mix.volume });
      push(0, CLS.setup, { type: "controlChange", trackIndex: ti, channel: ch, controller: 10, value: t.mix.pan });
      push(0, CLS.setup, { type: "controlChange", trackIndex: ti, channel: ch, controller: 11, value: t.mix.expression });
    }
  });
  const idx = new Map(p.tracks.map((t, i) => [t.id, i]));
  // Controllers: events before the range collapse to their last value at frame 0 (state at range start).
  const lastBefore = new Map<string, SynthEvent>();
  const ctl = (tick: number, key: string, cls: number, e: SynthEvent) => {
    if (tick < startTick) { lastBefore.set(key, e); return; }
    if (tick >= endTick && tick > startTick) return;
    push(at(tick), cls, e);
  };
  for (const c of p.ccs) { const ti = idx.get(c.trackId); if (ti === undefined) continue; ctl(c.tick, `cc:${c.channel}:${c.controller}`, CLS.cc, { type: "controlChange", trackIndex: ti, channel: c.channel, controller: c.controller, value: c.value }); }
  for (const b of p.pitchBends) { const ti = idx.get(b.trackId); if (ti === undefined) continue; ctl(b.tick, `pb:${b.channel}`, CLS.ctl, { type: "pitchBend", trackIndex: ti, channel: b.channel, velocity: b.value }); }
  for (const c of p.channelPressure) { const ti = idx.get(c.trackId); if (ti === undefined) continue; ctl(c.tick, `cp:${c.channel}`, CLS.ctl, { type: "channelPressure", trackIndex: ti, channel: c.channel, value: c.value }); }
  for (const c of p.polyPressure) { const ti = idx.get(c.trackId); if (ti === undefined) continue; ctl(c.tick, `pp:${c.channel}:${c.pitch}`, CLS.ctl, { type: "polyPressure", trackIndex: ti, channel: c.channel, note: c.pitch, value: c.value }); }
  for (const e of lastBefore.values()) push(0, CLS.cc, e);
  for (const n of p.notes) {
    const ti = idx.get(n.trackId); if (ti === undefined) continue;
    if (n.tick < startTick || n.tick >= endTick) continue;
    if (tracks[ti].gain === 0) continue; // muted: no voices
    audibleNotes++;
    push(at(n.tick), CLS.noteOn, { type: "noteOn", trackIndex: ti, channel: n.channel, note: n.pitch, velocity: n.velocity });
    push(at(n.tick + n.duration), CLS.noteOff, { type: "noteOff", trackIndex: ti, channel: n.channel, note: n.pitch });
  }
  if (p.raw.some((r) => r.kind === "sysex")) warnings.push("SysEx events are kept in the project/MIDI export but have no effect on the SF2 render");
  events.sort((a, b) => a.frame! - b.frame! || a.seq! - b.seq!);
  const lastEvent = events.length ? events[events.length - 1].frame! : 0;
  return { tracks, events, startFrame, musicFrames: Math.max(lastEvent, f(endTick) - startFrame, 0), instruments, warnings, audibleNotes };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new RenderError("INTERNAL_ERROR", "WebCrypto unavailable for SHA-256");
  const h = new Uint8Array(await subtle.digest("SHA-256", bytes as unknown as ArrayBuffer));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}
export { sha256Hex };

/** One deterministic pass over the plan. `sink` receives each rendered chunk (planar float). */
async function runEngine(plan: RenderPlan, sr: number, totalFrames: number, chunkFrames: number, sink: (l: Float32Array, r: Float32Array, n: number) => void, signal?: AbortSignal, onProgress?: (x: number) => void) {
  const engine = new Sf2SynthEngine(sr, { maxVoices: Math.max(96, plan.tracks.length * 24) });
  engine.setTrackStates(plan.tracks);
  const L = new Float32Array(chunkFrames), R = new Float32Array(chunkFrames);
  const ev = plan.events; let ei = 0;
  for (let cursor = 0; cursor < totalFrames; cursor += chunkFrames) {
    throwIfAborted(signal);
    const n = Math.min(chunkFrames, totalFrames - cursor);
    let local = 0;
    while (ei < ev.length && ev[ei].frame! < cursor + n) {
      const fr = Math.max(0, ev[ei].frame! - cursor);
      if (fr > local) { engine.renderRange(L.subarray(local, fr), R.subarray(local, fr)); local = fr; }
      engine.dispatchEvent(ev[ei++]);
    }
    if (n > local) engine.renderRange(L.subarray(local, n), R.subarray(local, n));
    sink(L, R, n);
    onProgress?.((cursor + n) / totalFrames);
    if (((cursor / chunkFrames) & 7) === 7) await yieldToEventLoop();
  }
}

/**
 * Render a project to a validated WAV. Resolves only with a complete, validated file; otherwise rejects with RenderError.
 * Works in a fresh page: no AudioContext, no user gesture, no mounted player, no pre-loaded SoundFont.
 */
export async function renderProjectOffline(project: Project, options: OfflineRenderOptions, signal?: AbortSignal, onProgress?: ProgressFn, deps: { soundFont?: LoadedSoundFont } = {}): Promise<RenderResult> {
  const t0 = Date.now();
  if (![44100, 48000].includes(options.sampleRate)) throw new RenderError("INVALID_ARGUMENT", "sampleRate must be 44100 or 48000");
  if (![1, 2].includes(options.channels)) throw new RenderError("INVALID_ARGUMENT", "channels must be 1 or 2");
  if (!["pcm16", "float32"].includes(options.format)) throw new RenderError("INVALID_ARGUMENT", "format must be pcm16 or float32");
  const tail = options.tailSeconds ?? 3;
  if (!(tail >= 0 && tail <= 30)) throw new RenderError("INVALID_ARGUMENT", "tailSeconds must be in [0, 30]");
  const p = structuredClone(project); // immutable snapshot
  if (!p.notes.length && !options.allowSilence) throw new RenderError("EMPTY_PROJECT", "project has no notes to render (pass allowSilence for an intentionally silent file)");
  onProgress?.(0, "loading");
  const sfl = deps.soundFont ?? await loadSoundFont({ signal, onProgress: (l, tot) => onProgress?.(tot ? l / tot : 0, "loading") });
  throwIfAborted(signal);
  onProgress?.(0, "resolving");
  const sr = options.sampleRate;
  const plan = buildRenderPlan(p, sfl.sf, sr, options);
  const tailFrames = Math.round(tail * sr);
  const totalFrames = plan.musicFrames + tailFrames;
  if (totalFrames <= 0) throw new RenderError("EMPTY_PROJECT", "nothing to render (zero length)");
  if (totalFrames / sr > (options.maxSeconds ?? 2400)) throw new RenderError("RENDER_TOO_LARGE", `render length ${(totalFrames / sr).toFixed(1)} s exceeds the ${(options.maxSeconds ?? 2400)} s limit`);
  const spec = { sampleRate: sr, channels: options.channels, format: options.format, frames: totalFrames } as const;
  const header = wavHeader(spec);
  const size = header.length + wavDataBytes(spec);
  if (size > (options.maxBytes ?? 1.5 * 2 ** 30)) throw new RenderError("RENDER_TOO_LARGE", `WAV would be ${(size / 2 ** 20).toFixed(0)} MiB, over the in-browser limit`);
  if (!plan.audibleNotes && !options.allowSilence) throw new RenderError("UNEXPECTED_SILENCE", "every track with notes is muted (or no notes in range); nothing audible to render");
  const chunk = options.chunkFrames ?? 8192;
  let gain = 1;
  if (options.normalize) {
    let peak = 0;
    await runEngine(plan, sr, totalFrames, chunk, (l, r, n) => { for (let i = 0; i < n; i++) { const a = Math.max(Math.abs(l[i]), Math.abs(r[i])); if (a > peak) peak = a; } }, signal, (x) => onProgress?.(x * 0.5, "rendering"));
    gain = peak > 0 ? Math.pow(10, -1 / 20) / peak : 1;
  }
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(size); } catch { throw new RenderError("RENDER_TOO_LARGE", `could not allocate ${(size / 2 ** 20).toFixed(0)} MiB for the WAV`); }
  bytes.set(header);
  let off = header.length;
  const enc = { clipped: 0, nonFinite: 0 };
  await runEngine(plan, sr, totalFrames, chunk, (l, r, n) => { const b = encodeChunk(spec, l, r, n, gain, enc); bytes.set(b, off); off += b.length; }, signal,
    (x) => onProgress?.(options.normalize ? 0.5 + x * 0.5 : x, "rendering"));
  if (enc.nonFinite) throw new RenderError("NON_FINITE_SAMPLES", `${enc.nonFinite} NaN/Infinity samples produced by the synth`);
  if (off !== size) throw new RenderError("INTERNAL_ERROR", `encoded ${off} bytes, expected ${size}`);
  onProgress?.(1, "encoding");
  const sha256 = await sha256Hex(bytes);
  const blob = new Blob([bytes as BlobPart], { type: "audio/wav" });
  throwIfAborted(signal);
  onProgress?.(0, "validating");
  const v = await validateWav(bytes, {
    sampleRate: sr, channels: options.channels, format: options.format, frames: totalFrames, durationSeconds: totalFrames / sr, toleranceSeconds: 1 / sr,
    expectAudible: !options.allowSilence, silenceThresholdDbFS: options.silenceThresholdDbFS, maxClippedFraction: options.maxClippedFraction,
  });
  onProgress?.(1, "validating");
  return {
    blob, bytes, sha256, mimeType: "audio/wav", durationSeconds: v.info.durationSeconds, musicSeconds: plan.musicFrames / sr, tailSeconds: tail,
    sampleRate: sr, channels: options.channels, format: options.format, framesRendered: totalFrames, byteLength: size,
    peakDbFS: v.stats.peakDbFS, rmsDbFS: v.stats.rmsDbFS, clippedSamples: v.stats.clippedSamples, gain: +gain.toFixed(6), validated: true,
    wav: v.info, stats: v.stats, instruments: plan.instruments, warnings: [...plan.warnings, ...v.warnings], soundFont: sfl.label, noteCount: plan.audibleNotes, renderMs: Date.now() - t0,
  };
}
