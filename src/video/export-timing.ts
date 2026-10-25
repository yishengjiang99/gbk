// Pure timing math for the in-browser video export (unit-tested): frame i shows time i/fps; audio is chunked
// into fixed-size AudioData blocks. All timestamps are integer microseconds (WebCodecs units).
export const US = 1_000_000;
/** Number of video frames covering `duration` seconds (last frame starts before the end). */
export const exportFrameCount = (duration: number, fps: number) => Math.max(1, Math.ceil(duration * fps - 1e-9));
/** Frame i presentation timestamp (µs). Rounded per frame so drift never accumulates. */
export const frameTimestampUs = (i: number, fps: number) => Math.round((i * US) / fps);
/** Frame i duration (µs): difference of rounded timestamps, so durations sum exactly to the next timestamp. */
export const frameDurationUs = (i: number, fps: number) => frameTimestampUs(i + 1, fps) - frameTimestampUs(i, fps);
/** Audio chunks [start, length) in sample frames; timestamps (µs) of each chunk start. */
export function audioChunks(totalFrames: number, sampleRate: number, chunk = 4096): { start: number; length: number; timestampUs: number }[] {
  const out: { start: number; length: number; timestampUs: number }[] = [];
  for (let s = 0; s < totalFrames; s += chunk) out.push({ start: s, length: Math.min(chunk, totalFrames - s), timestampUs: Math.round((s * US) / sampleRate) });
  return out;
}
/** Overall progress: audio render takes the first `audioShare`, frame encoding the rest. */
export const exportProgress = (stage: "audio" | "video", x: number, audioShare = 0.35) => stage === "audio" ? audioShare * clamp01(x) : audioShare + (1 - audioShare) * clamp01(x);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** Even (H.264 needs even dims) output size for a target height at 16:9. */
export function evenSize(height: number, aspect = 16 / 9) { const h = Math.round(height / 2) * 2; return { width: Math.round((h * aspect) / 2) * 2, height: h }; }
/** Parse a PCM16 / float32 little-endian WAV into planar Float32 channels. */
export function parseWav(bytes: Uint8Array): { sampleRate: number; channels: Float32Array[] } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
  let o = 12, fmt = 1, nch = 2, sr = 44100, bits = 16;
  while (o + 8 <= bytes.length) {
    const id = tag(o), size = dv.getUint32(o + 4, true), body = o + 8;
    if (id === "fmt ") { fmt = dv.getUint16(body, true); nch = dv.getUint16(body + 2, true); sr = dv.getUint32(body + 4, true); bits = dv.getUint16(body + 14, true); if (fmt === 0xfffe) fmt = dv.getUint16(body + 24, true); }
    if (id === "data") {
      const bps = bits / 8, n = Math.floor(Math.min(size, bytes.length - body) / (bps * nch));
      const ch = Array.from({ length: nch }, () => new Float32Array(n));
      for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) {
        const p = body + (i * nch + c) * bps;
        ch[c][i] = fmt === 3 && bits === 32 ? dv.getFloat32(p, true) : dv.getInt16(p, true) / 32768;
      }
      return { sampleRate: sr, channels: ch };
    }
    o = body + size + (size & 1);
  }
  throw new Error("WAV has no data chunk");
}
