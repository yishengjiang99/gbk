// Streaming WAV encoder: RIFF/WAVE (or RF64 above the 4 GiB RIFF limit), PCM16 or IEEE float32, mono/stereo,
// little-endian. The frame count is known up front (offline render), so the header is final from the start
// and chunks can be appended to a Blob / storage stream without holding the whole file in memory.
export type WavFormat = "pcm16" | "float32";
export interface WavSpec { sampleRate: number; channels: 1 | 2; format: WavFormat; frames: number }

export const bytesPerSample = (f: WavFormat) => (f === "pcm16" ? 2 : 4);
export const RIFF_MAX = 0xffffffff;

export function wavDataBytes(s: WavSpec): number { return s.frames * s.channels * bytesPerSample(s.format); }

/** Header bytes for `spec`. PCM16: 44 bytes. float32: fmt (18) + fact chunk -> 58 bytes. RF64 adds ds64. */
export function wavHeader(s: WavSpec, forceRf64 = false): Uint8Array {
  const bps = bytesPerSample(s.format), blockAlign = s.channels * bps, dataBytes = wavDataBytes(s);
  const float = s.format === "float32";
  const fmtLen = float ? 18 : 16;
  const factLen = float ? 12 : 0;
  const rf64 = forceRf64 || 4 + (8 + fmtLen) + factLen + 8 + dataBytes > RIFF_MAX - 36;
  const ds64Len = rf64 ? 8 + 28 : 0;
  const headerLen = 12 + ds64Len + 8 + fmtLen + factLen + 8;
  const b = new ArrayBuffer(headerLen); const v = new DataView(b); let o = 0;
  const tag = (t: string) => { for (let i = 0; i < 4; i++) v.setUint8(o++, t.charCodeAt(i)); };
  const u32 = (x: number) => { v.setUint32(o, x, true); o += 4; };
  const u16 = (x: number) => { v.setUint16(o, x, true); o += 2; };
  const u64 = (x: number) => { v.setUint32(o, x % 2 ** 32, true); v.setUint32(o + 4, Math.floor(x / 2 ** 32), true); o += 8; };
  const riffSize = headerLen - 8 + dataBytes;
  tag(rf64 ? "RF64" : "RIFF"); u32(rf64 ? RIFF_MAX : riffSize); tag("WAVE");
  if (rf64) { tag("ds64"); u32(28); u64(riffSize); u64(dataBytes); u64(s.frames); u32(0); }
  tag("fmt "); u32(fmtLen); u16(float ? 3 : 1); u16(s.channels); u32(s.sampleRate); u32(s.sampleRate * blockAlign); u16(blockAlign); u16(bps * 8);
  if (float) u16(0);
  if (float) { tag("fact"); u32(4); u32(Math.min(RIFF_MAX, s.frames)); }
  tag("data"); u32(rf64 ? RIFF_MAX : dataBytes);
  return new Uint8Array(b);
}

export interface EncodeStats { clipped: number; nonFinite: number }

/** Encode one chunk of planar float audio (L/R) to interleaved little-endian bytes with `gain`. Mono = (L+R)/2. */
export function encodeChunk(s: Pick<WavSpec, "channels" | "format">, left: Float32Array, right: Float32Array, frames: number, gain = 1, stats?: EncodeStats): Uint8Array {
  const bps = bytesPerSample(s.format);
  const out = new ArrayBuffer(frames * s.channels * bps); const v = new DataView(out);
  let o = 0;
  const put = (x: number) => {
    if (!Number.isFinite(x)) { if (stats) stats.nonFinite++; x = 0; }
    x *= gain;
    if (x > 1 || x < -1) { if (stats) stats.clipped++; }
    if (s.format === "pcm16") {
      const c = x > 1 ? 1 : x < -1 ? -1 : x;
      v.setInt16(o, c < 0 ? Math.round(c * 32768) : Math.round(c * 32767), true); o += 2;
    } else { v.setFloat32(o, x, true); o += 4; }
  };
  if (s.channels === 2) for (let i = 0; i < frames; i++) { put(left[i]); put(right[i]); }
  else for (let i = 0; i < frames; i++) put((left[i] + right[i]) * 0.5);
  return new Uint8Array(out);
}

/** Convenience for small buffers / tests: encode planar channels in one call. */
export function encodeWav(spec: Omit<WavSpec, "frames">, left: Float32Array, right: Float32Array = left): Uint8Array {
  const frames = left.length;
  const h = wavHeader({ ...spec, frames });
  const d = encodeChunk(spec, left, right, frames);
  const out = new Uint8Array(h.length + d.length); out.set(h); out.set(d, h.length);
  return out;
}
