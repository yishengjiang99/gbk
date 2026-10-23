// WAV inspection + audio statistics. Validates the actual bytes of a rendered file (header fields, sizes,
// duration, finite samples) and computes peak / RMS / clipping / silence with configurable thresholds.
import { RenderError } from "./render-error.ts";

export interface WavInfo {
  container: "RIFF" | "RF64"; audioFormat: 1 | 3; format: "pcm16" | "float32"; channels: number; sampleRate: number;
  byteRate: number; blockAlign: number; bitsPerSample: number; dataOffset: number; dataBytes: number; frames: number; durationSeconds: number;
}

const tag = (u: Uint8Array, o: number) => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);

/** Parse + structurally validate a WAV header (first bytes of the file). `fileBytes` = total file size. */
export function parseWavHeader(u: Uint8Array, fileBytes = u.length): WavInfo {
  const bad = (m: string): never => { throw new RenderError("WAV_INVALID", m); };
  if (u.length < 12) bad("file too short for a RIFF header");
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const container = tag(u, 0);
  if (container !== "RIFF" && container !== "RF64") bad(`missing RIFF/RF64 identifier (got ${JSON.stringify(container)})`);
  if (tag(u, 8) !== "WAVE") bad("missing WAVE identifier");
  const riffSize = dv.getUint32(4, true);
  if (container === "RIFF" && riffSize + 8 !== fileBytes) bad(`RIFF size ${riffSize} + 8 != file size ${fileBytes}`);
  let o = 12; let fmt: Omit<WavInfo, "container" | "dataOffset" | "dataBytes" | "frames" | "durationSeconds"> | null = null;
  let ds64Data: number | null = null;
  while (o + 8 <= u.length) {
    const id = tag(u, o); const size = dv.getUint32(o + 4, true); const body = o + 8;
    if (id === "ds64") { if (body + 28 > u.length) bad("truncated ds64"); ds64Data = dv.getUint32(body + 8, true) + dv.getUint32(body + 12, true) * 2 ** 32; }
    else if (id === "fmt ") {
      if (size < 16 || body + 16 > u.length) bad("fmt chunk too short");
      const audioFormat = dv.getUint16(body, true), channels = dv.getUint16(body + 2, true), sampleRate = dv.getUint32(body + 4, true);
      const byteRate = dv.getUint32(body + 8, true), blockAlign = dv.getUint16(body + 12, true), bitsPerSample = dv.getUint16(body + 14, true);
      let fmtName: "pcm16" | "float32";
      if (audioFormat === 1 && bitsPerSample === 16) fmtName = "pcm16";
      else if (audioFormat === 3 && bitsPerSample === 32) fmtName = "float32";
      else return bad(`unsupported encoding format=${audioFormat} bits=${bitsPerSample}`);
      if (channels < 1 || channels > 2) bad(`unexpected channel count ${channels}`);
      if (sampleRate < 8000 || sampleRate > 192000) bad(`implausible sample rate ${sampleRate}`);
      if (blockAlign !== channels * (bitsPerSample / 8)) bad(`blockAlign ${blockAlign} != channels*bytes`);
      if (byteRate !== sampleRate * blockAlign) bad(`byteRate ${byteRate} != sampleRate*blockAlign`);
      fmt = { audioFormat: audioFormat as 1 | 3, format: fmtName, channels, sampleRate, byteRate, blockAlign, bitsPerSample };
    } else if (id === "data") {
      if (!fmt) bad("data chunk before fmt chunk");
      const dataBytes = size === 0xffffffff && container === "RF64" ? (ds64Data ?? bad("RF64 without ds64")) : size;
      if (body + dataBytes > fileBytes) bad(`data chunk (${dataBytes} bytes) extends past end of file (${fileBytes})`);
      if (dataBytes % fmt!.blockAlign !== 0) bad("data length is not a whole number of frames");
      const frames = dataBytes / fmt!.blockAlign;
      return { container: container as "RIFF" | "RF64", ...fmt!, dataOffset: body, dataBytes, frames, durationSeconds: frames / fmt!.sampleRate };
    }
    o = body + size + (size & 1);
  }
  return bad("missing data chunk");
}

export interface AudioStats {
  frames: number; peak: number; peakDbFS: number; rms: number; rmsDbFS: number; clippedSamples: number; nonFiniteSamples: number;
  /** RMS (dBFS) per window, for loudness-over-time checks (e.g. CC11 curves) and silence detection. */
  windowRmsDbFS: number[]; windowSeconds: number; silentWindows: number; firstAudibleSec: number | null; lastAudibleSec: number | null;
}

export const toDb = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const round = (x: number) => (Number.isFinite(x) ? +x.toFixed(2) : -999);

/** Incremental statistics accumulator over interleaved samples (normalized to [-1, 1]). */
export class StatsAccumulator {
  private sumSq = 0; private n = 0; private peak = 0; private clipped = 0; private nonFinite = 0; private frames = 0;
  private winSum = 0; private winN = 0; private win: number[] = []; private winFrames: number;
  constructor(private sampleRate: number, private channels: number, public windowSeconds = 0.1, private clipThreshold = 1) { this.winFrames = Math.max(1, Math.round(sampleRate * windowSeconds)); }
  push(sample: number, isFrameEnd: boolean) {
    if (!Number.isFinite(sample)) { this.nonFinite++; sample = 0; }
    const a = Math.abs(sample);
    if (a > this.peak) this.peak = a;
    if (a >= this.clipThreshold) this.clipped++;
    this.sumSq += sample * sample; this.n++; this.winSum += sample * sample; this.winN++;
    if (isFrameEnd) { this.frames++; if (this.frames % this.winFrames === 0) this.flush(); }
  }
  private flush() { if (this.winN) this.win.push(Math.sqrt(this.winSum / this.winN)); this.winSum = 0; this.winN = 0; }
  finish(silenceDbFS = -70): AudioStats {
    if (this.winN) this.flush();
    const rms = this.n ? Math.sqrt(this.sumSq / this.n) : 0;
    const winDb = this.win.map((r) => round(toDb(r)));
    let first: number | null = null, last: number | null = null, silent = 0;
    winDb.forEach((d, i) => { if (d > silenceDbFS) { if (first === null) first = i * this.windowSeconds; last = (i + 1) * this.windowSeconds; } else silent++; });
    return { frames: this.frames, peak: this.peak, peakDbFS: round(toDb(this.peak)), rms, rmsDbFS: round(toDb(rms)), clippedSamples: this.clipped, nonFiniteSamples: this.nonFinite,
      windowRmsDbFS: winDb, windowSeconds: this.windowSeconds, silentWindows: silent, firstAudibleSec: first, lastAudibleSec: last };
  }
}

export interface WavExpectations {
  sampleRate?: number; channels?: number; format?: "pcm16" | "float32"; frames?: number;
  /** Expected duration (seconds) +/- toleranceSeconds. */
  durationSeconds?: number; toleranceSeconds?: number;
  /** When true (default) an all-silent file fails. Set false when silence is intentional. */
  expectAudible?: boolean;
  /** Peak below this (dBFS) counts as silent. Default -60 dBFS. Very quiet pieces can lower it. */
  silenceThresholdDbFS?: number;
  /** Maximum fraction of samples at full scale before failing. Default 0.0001 (0.01 %). */
  maxClippedFraction?: number;
  windowSeconds?: number;
}
export interface WavValidation { ok: true; info: WavInfo; stats: AudioStats; warnings: string[] }

async function bytesOf(src: Blob | Uint8Array, start: number, end: number): Promise<Uint8Array> {
  if (src instanceof Uint8Array) return src.subarray(start, end);
  return new Uint8Array(await src.slice(start, end).arrayBuffer());
}

/** Validate a complete WAV (Blob or bytes) against expectations. Reads the data in bounded chunks. Throws RenderError. */
export async function validateWav(src: Blob | Uint8Array, exp: WavExpectations = {}): Promise<WavValidation> {
  const size = src instanceof Uint8Array ? src.length : src.size;
  const info = parseWavHeader(await bytesOf(src, 0, Math.min(size, 4096)), size);
  const bad = (m: string, code: "WAV_INVALID" | "UNEXPECTED_SILENCE" | "UNEXPECTED_CLIPPING" | "NON_FINITE_SAMPLES" = "WAV_INVALID"): never => { throw new RenderError(code, m, { info }); };
  if (exp.sampleRate && info.sampleRate !== exp.sampleRate) bad(`sample rate ${info.sampleRate} != expected ${exp.sampleRate}`);
  if (exp.channels && info.channels !== exp.channels) bad(`channels ${info.channels} != expected ${exp.channels}`);
  if (exp.format && info.format !== exp.format) bad(`format ${info.format} != expected ${exp.format}`);
  if (exp.frames !== undefined && info.frames !== exp.frames) bad(`frames ${info.frames} != expected ${exp.frames}`);
  if (exp.durationSeconds !== undefined && Math.abs(info.durationSeconds - exp.durationSeconds) > (exp.toleranceSeconds ?? 0.05)) bad(`duration ${info.durationSeconds.toFixed(3)} s != expected ${exp.durationSeconds.toFixed(3)} s`);
  const acc = new StatsAccumulator(info.sampleRate, info.channels, exp.windowSeconds ?? 0.1, info.format === "pcm16" ? 32767 / 32768 : 1);
  const CH = 1 << 20; const bpsamp = info.bitsPerSample / 8;
  let sIdx = 0;
  for (let off = 0; off < info.dataBytes; off += CH) {
    const len = Math.min(CH, info.dataBytes - off);
    const chunk = await bytesOf(src, info.dataOffset + off, info.dataOffset + off + len);
    const dv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    for (let i = 0; i + bpsamp <= chunk.length; i += bpsamp) {
      const x = bpsamp === 2 ? dv.getInt16(i, true) / 32768 : dv.getFloat32(i, true);
      sIdx++;
      acc.push(x, sIdx % info.channels === 0);
    }
  }
  const stats = acc.finish(exp.silenceThresholdDbFS !== undefined ? Math.min(-70, exp.silenceThresholdDbFS - 10) : -70);
  const warnings: string[] = [];
  if (stats.nonFiniteSamples) bad(`${stats.nonFiniteSamples} NaN/Infinity samples`, "NON_FINITE_SAMPLES");
  const silence = exp.silenceThresholdDbFS ?? -60;
  if ((exp.expectAudible ?? true) && !(stats.peakDbFS > silence)) bad(`unexpected silence: peak ${stats.peakDbFS} dBFS <= ${silence} dBFS`, "UNEXPECTED_SILENCE");
  const total = stats.frames * info.channels;
  const frac = total ? stats.clippedSamples / total : 0;
  if (frac > (exp.maxClippedFraction ?? 1e-4)) bad(`unexpected clipping: ${stats.clippedSamples} samples (${(frac * 100).toFixed(3)} %) at full scale`, "UNEXPECTED_CLIPPING");
  if (stats.clippedSamples) warnings.push(`${stats.clippedSamples} sample(s) at full scale`);
  return { ok: true, info, stats, warnings };
}
