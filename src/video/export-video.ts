// In-browser "Export video": offline SF2 render (same path as Export WAV) + moving piano roll frames on a canvas,
// encoded with WebCodecs (H.264 + AAC/Opus) into MP4 via mp4-muxer. Nothing is paced by the wall clock: audio comes
// from the OfflineAudioContext render, frames are drawn per timestamp i/fps as fast as the encoder accepts them.
// Browsers with VideoEncoder but no AudioEncoder (Safari before 26): H.264 + uncompressed PCM in a .mov (mediabunny),
// still faster than real time. Only browsers with no VideoEncoder at all (old iOS) fall back to real-time MediaRecorder,
// which still plays the offline-rendered buffer as its audio source.
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { Output, MovOutputFormat, BufferTarget, EncodedVideoPacketSource, EncodedPacket, AudioSampleSource, AudioSample } from "mediabunny";
import type { Project } from "../workstation/model.ts";
import { renderJobs, safeFilename } from "../audio/render-job.ts";
import { buildVideoModel, drawFrame, type VideoModel, type VideoOptions } from "./piano-roll-video.ts";
import { reportError } from "../telemetry/error-reporter.ts";
import { audioChunks, evenSize, exportFrameCount, exportProgress, frameDurationUs, frameTimestampUs, parseWav } from "./export-timing.ts";

export interface VideoExportState { running: boolean; progress: number; stage: string; error?: string; method?: string }
let state: VideoExportState = { running: false, progress: 0, stage: "" };
const subs = new Set<(s: VideoExportState) => void>();
let abort: AbortController | null = null;
const set = (p: Partial<VideoExportState>) => { state = { ...state, ...p }; for (const f of subs) f(state); };
export const videoExportState = () => state;
export const subscribeVideoExport = (f: (s: VideoExportState) => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const cancelVideoExport = () => abort?.abort();

const FPS = 30;
const LOGICAL = { width: 1920, height: 1080 }; // drawFrame layout units; scaled onto the output canvas
const cancelled = () => Object.assign(new Error("Video export cancelled"), { name: "AbortError" });

/** Run an export and return the file; progress via subscribeVideoExport. */
export async function exportVideo(project: Project, opts: { height?: number; download?: (b: Blob, name: string) => void } = {}): Promise<{ blob: Blob; filename: string } | null> {
  if (state.running) return null;
  abort = new AbortController(); const signal = abort.signal;
  // iOS only lets an AudioContext start inside the tap: prime one now in case we need the MediaRecorder fallback
  // (Safari before 26 has VideoEncoder but no AudioEncoder).
  const primed = typeof AudioEncoder === "undefined" && typeof AudioContext !== "undefined" ? new AudioContext({ sampleRate: 48000 }) : null;
  void primed?.resume().catch(() => undefined);
  set({ running: true, progress: 0, stage: "Rendering audio", error: undefined, method: undefined });
  const t0 = performance.now(); let tAudio = 0;
  try {
    const job = renderJobs().submit(project, { sampleRate: 48000, channels: 2, format: "pcm16", tailSeconds: 2 }, { saveArtifact: false, signal });
    const unsub = renderJobs().subscribe((j) => { if (j.id === job.id) set({ progress: exportProgress("audio", j.progress) }); });
    const done = await renderJobs().wait(job.id).finally(unsub);
    if (signal.aborted || done.status === "cancelled") throw cancelled();
    if (done.status !== "completed") throw new Error(`audio render ${done.status}: ${done.error?.message ?? ""}`);
    const r = renderJobs().result(job.id); if (!r) throw new Error("audio render result missing");
    const audio = parseWav(r.bytes);
    tAudio = performance.now() - t0;
    assertAudible(project, audio.channels);
    const duration = audio.channels[0].length / audio.sampleRate;
    const model = buildVideoModel(project, duration, `${project.tracks.length} tracks · GBK Composer`);
    const size = evenSize(opts.height ?? 720);
    const vo: VideoOptions = { ...LOGICAL, fps: FPS, windowSeconds: 8, playheadFrac: 0.3, theme: "light" };
    set({ stage: "Encoding video", progress: exportProgress("audio", 1) });
    let out: { blob: Blob; ext: string; method: string; note?: string };
    const wc = await pickWebCodecs(size, audio.sampleRate, audio.channels.length);
    if (wc?.audio) out = await encodeWebCodecs(model, vo, size, audio, { video: wc.video, audio: wc.audio, audioCodec: wc.audioCodec! }, signal);
    else if (wc) out = await encodeVideoPcmMov(model, vo, size, audio, wc.video, signal);
    else if (typeof MediaRecorder !== "undefined") out = await encodeMediaRecorder(model, vo, size, audio, signal, primed);
    else throw new Error("This browser cannot encode video (no WebCodecs or MediaRecorder)");
    const filename = safeFilename(project.name, out.ext);
    const info = { method: out.method, songSeconds: +duration.toFixed(2), audioMs: Math.round(tAudio), encodeMs: Math.round(performance.now() - t0 - tAudio), totalMs: Math.round(performance.now() - t0), peakDb: peakDb(audio.channels), bytes: out.blob.size, ...(out.note ? { note: out.note } : {}) };
    console.info(`[export-video] ${JSON.stringify(info)}`);
    reportError(new Error(`export-video ok: ${out.method}`), { where: "export-video", ...info }); // telemetry: which path iPhones take
    set({ running: false, progress: 1, stage: `Done (${out.method})`, method: out.method });
    opts.download?.(out.blob, filename);
    return { blob: out.blob, filename };
  } catch (e) {
    const err = e as Error;
    const aborted = signal.aborted || err.name === "AbortError";
    set({ running: false, stage: aborted ? "Cancelled" : "Failed", error: aborted ? undefined : err.message });
    if (!aborted) throw err;
    return null;
  } finally { abort = null; if (primed && primed.state !== "closed") void primed.close().catch(() => undefined); }
}

/** Never export a silent video: a project with notes must render a non-silent mix (e.g. SoundFont failed to load). */
function assertAudible(project: Project, channels: Float32Array[]) {
  if (!project.notes.length) return;
  let peak = 0; for (const ch of channels) for (let i = 0; i < ch.length; i += 7) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
  if (!(peak > 1e-4)) throw new Error("the rendered audio is silent (SoundFont not loaded or all tracks muted); not exporting a silent video");
}

const peakDb = (chs: Float32Array[]) => { let p = 0; for (const ch of chs) for (let i = 0; i < ch.length; i += 7) { const a = Math.abs(ch[i]); if (a > p) p = a; } return p > 0 ? +(20 * Math.log10(p)).toFixed(1) : -Infinity; };

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
/** AAC-LC AudioSpecificConfig (ISO 14496-3 1.6.2.1) for our own stream parameters. */
export function aacLcAsc(sampleRate: number, channels: number): Uint8Array {
  const fi = AAC_RATES.indexOf(sampleRate); if (fi < 0) throw new Error(`no AAC sample-rate index for ${sampleRate}`);
  const v = (2 << 11) | (fi << 7) | (channels << 3); return new Uint8Array([v >> 8, v & 0xff]);
}
/** WebKit (Safari/iOS 26, bug 302253) hands back an esds box body as the AAC "description" instead of an
 *  AudioSpecificConfig; muxed as-is the track reads as 22.05 kHz / 0 channels and plays SILENT on iPhone.
 *  We only ever encode AAC-LC at a known rate/channel count, so always write the correct ASC ourselves. */
export function fixAacMeta(meta: EncodedAudioChunkMetadata | undefined, sampleRate: number, channels: number): { meta: EncodedAudioChunkMetadata | undefined; replaced: boolean } {
  const dc = meta?.decoderConfig; if (!dc) return { meta, replaced: false };
  const want = aacLcAsc(sampleRate, channels);
  const d = dc.description ? new Uint8Array(dc.description instanceof ArrayBuffer ? dc.description : (dc.description as ArrayBufferView).buffer.slice((dc.description as ArrayBufferView).byteOffset, (dc.description as ArrayBufferView).byteOffset + (dc.description as ArrayBufferView).byteLength)) : null;
  const same = !!d && d.length >= 2 && d[0] === want[0] && (d[1] & 0xf8) === (want[1] & 0xf8);
  return { meta: { ...meta, decoderConfig: { ...dc, description: same ? dc.description : want } }, replaced: !same };
}

type Size = { width: number; height: number };
interface WcPlan { video: VideoEncoderConfig; audio: AudioEncoderConfig; audioCodec: "aac" | "opus" }

/** H.264 config plus, when the browser can encode AAC/Opus, the audio config; audio null -> PCM .mov path. */
async function pickWebCodecs(size: Size, sampleRate: number, channels: number): Promise<{ video: VideoEncoderConfig; audio: AudioEncoderConfig | null; audioCodec?: "aac" | "opus" } | null> {
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return null;
  let video: VideoEncoderConfig | null = null;
  // H.264 High / Main / Baseline (level 3.1 covers 720p30). Safari and Chrome both encode avc1.
  for (const codec of ["avc1.640028", "avc1.4d401f", "avc1.42001f"]) {
    const c: VideoEncoderConfig = { codec, width: size.width, height: size.height, bitrate: 3_000_000, framerate: FPS, avc: { format: "avc" } };
    try { if ((await VideoEncoder.isConfigSupported(c)).supported) { video = c; break; } } catch { /* try next */ }
  }
  if (!video) return null;
  if (typeof AudioEncoder === "undefined" || typeof AudioData === "undefined") return { video, audio: null };
  for (const [codec, audioCodec] of [["mp4a.40.2", "aac"], ["opus", "opus"]] as const) {
    const c: AudioEncoderConfig = { codec, sampleRate, numberOfChannels: channels, bitrate: 160_000 };
    try { if ((await AudioEncoder.isConfigSupported(c)).supported) return { video, audio: c, audioCodec }; } catch { /* try next */ }
  }
  return { video, audio: null };
}

/** Frame loop shared by both WebCodecs paths: deterministic t = i/fps, encoder backpressure only (no wall clock). */
async function encodeFrames(m: VideoModel, vo: VideoOptions, size: Size, venc: VideoEncoder, signal: AbortSignal, failed: () => Error | null) {
  const { c, ctx } = makeCanvas(size);
  const frames = exportFrameCount(m.duration, FPS);
  for (let i = 0; i < frames; i++) {
    if (signal.aborted) throw cancelled(); const f = failed(); if (f) throw f;
    draw(ctx, m, i / FPS, vo, size);
    const vf = new VideoFrame(c as CanvasImageSource, { timestamp: frameTimestampUs(i, FPS), duration: frameDurationUs(i, FPS) });
    venc.encode(vf, { keyFrame: i % (FPS * 2) === 0 }); vf.close();
    while (venc.encodeQueueSize > 6) await tick();
    if (i % 15 === 0) { set({ progress: exportProgress("video", i / frames) }); await tick(); }
  }
  await venc.flush();
}

/** Safari without AudioEncoder: H.264 frames + 16-bit PCM of the offline mix in a QuickTime .mov (plays natively on iOS/macOS). */
async function encodeVideoPcmMov(m: VideoModel, vo: VideoOptions, size: Size, audio: { sampleRate: number; channels: Float32Array[] }, video: VideoEncoderConfig, signal: AbortSignal) {
  const output = new Output({ format: new MovOutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
  const vsrc = new EncodedVideoPacketSource("avc"); output.addVideoTrack(vsrc, { frameRate: FPS });
  const asrc = new AudioSampleSource({ codec: "pcm-s16" }); output.addAudioTrack(asrc);
  await output.start();
  let failure: Error | null = null; let chain: Promise<void> = Promise.resolve();
  const venc = new VideoEncoder({ output: (ch, meta) => { chain = chain.then(() => vsrc.add(EncodedPacket.fromEncodedChunk(ch), meta)).catch((e) => { failure = e as Error; }); }, error: (e) => { failure = e as Error; } });
  venc.configure(video);
  try {
    const total = audio.channels[0].length, nch = audio.channels.length;
    for (const ch of audioChunks(total, audio.sampleRate, 48000)) {
      const buf = new Float32Array(ch.length * nch);
      for (let c = 0; c < nch; c++) buf.set(audio.channels[c].subarray(ch.start, ch.start + ch.length), c * ch.length);
      const s = new AudioSample({ format: "f32-planar", sampleRate: audio.sampleRate, numberOfChannels: nch, timestamp: ch.start / audio.sampleRate, data: buf });
      await asrc.add(s); s.close();
    }
    await encodeFrames(m, vo, size, venc, signal, () => failure);
    await chain; if (failure) throw failure;
    await output.finalize();
    return { blob: new Blob([(output.target as BufferTarget).buffer!], { type: "video/quicktime" }), ext: "mov", method: "WebCodecs H.264 + PCM (.mov)" };
  } catch (e) { void output.cancel().catch(() => undefined); throw e; }
  finally { try { venc.close(); } catch { /* closed */ } }
}

function makeCanvas(size: Size) {
  if (typeof OffscreenCanvas !== "undefined") { const c = new OffscreenCanvas(size.width, size.height); const ctx = c.getContext("2d"); if (ctx) return { c, ctx }; }
  const c = document.createElement("canvas"); c.width = size.width; c.height = size.height; return { c, ctx: c.getContext("2d")! };
}
const draw = (ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, m: VideoModel, t: number, vo: VideoOptions, size: Size) => {
  ctx.setTransform(size.width / vo.width, 0, 0, size.height / vo.height, 0, 0); drawFrame(ctx, m, t, vo);
};
const tick = () => new Promise((r) => setTimeout(r, 0));

async function encodeWebCodecs(m: VideoModel, vo: VideoOptions, size: Size, audio: { sampleRate: number; channels: Float32Array[] }, plan: WcPlan, signal: AbortSignal) {
  const muxer = new Muxer({ target: new ArrayBufferTarget(), fastStart: "in-memory", firstTimestampBehavior: "offset",
    video: { codec: "avc", width: size.width, height: size.height, frameRate: FPS },
    audio: { codec: plan.audioCodec, sampleRate: audio.sampleRate, numberOfChannels: audio.channels.length } });
  let failure: Error | null = null;
  const venc = new VideoEncoder({ output: (c, meta) => muxer.addVideoChunk(c, meta), error: (e) => { failure = e as Error; } });
  let audioBytes = 0; let ascReplaced = false;
  const aenc = new AudioEncoder({ output: (c, meta) => {
    audioBytes += c.byteLength;
    if (plan.audioCodec === "aac") { const f = fixAacMeta(meta, audio.sampleRate, audio.channels.length); meta = f.meta; ascReplaced ||= f.replaced; }
    muxer.addAudioChunk(c, meta);
  }, error: (e) => { failure = e as Error; } });
  venc.configure(plan.video); aenc.configure(plan.audio);
  try {
    // Audio first (fast), then frames; the muxer interleaves by timestamp.
    const total = audio.channels[0].length, nch = audio.channels.length;
    for (const ch of audioChunks(total, audio.sampleRate, 4096)) {
      const buf = new Float32Array(ch.length * nch);
      for (let c = 0; c < nch; c++) buf.set(audio.channels[c].subarray(ch.start, ch.start + ch.length), c * ch.length);
      const ad = new AudioData({ format: "f32-planar", sampleRate: audio.sampleRate, numberOfFrames: ch.length, numberOfChannels: nch, timestamp: ch.timestampUs, data: buf });
      aenc.encode(ad); ad.close();
      while (aenc.encodeQueueSize > 32) await tick();
    }
    await encodeFrames(m, vo, size, venc, signal, () => failure);
    await aenc.flush(); if (failure) throw failure;
    if (audioBytes === 0) throw new Error(`the ${plan.audioCodec.toUpperCase()} audio encoder produced no output; not exporting a silent video`);
    muxer.finalize();
    return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), ext: "mp4", method: `WebCodecs H.264 + ${plan.audioCodec.toUpperCase()}`, note: ascReplaced ? "aac-description-replaced" : undefined };
  } finally { try { venc.close(); } catch { /* closed */ } try { aenc.close(); } catch { /* closed */ } }
}

/** Real-time fallback: plays the rendered audio silently into a MediaStream while drawing frames from its clock. */
async function encodeMediaRecorder(m: VideoModel, vo: VideoOptions, size: Size, audio: { sampleRate: number; channels: Float32Array[] }, signal: AbortSignal, primed: AudioContext | null) {
  const canvas = document.createElement("canvas"); canvas.width = size.width; canvas.height = size.height; const ctx = canvas.getContext("2d")!;
  const ac = primed && primed.sampleRate === audio.sampleRate ? primed : new AudioContext({ sampleRate: audio.sampleRate });
  const buf = ac.createBuffer(audio.channels.length, audio.channels[0].length, audio.sampleRate);
  audio.channels.forEach((d, i) => buf.copyToChannel(d as Float32Array<ArrayBuffer>, i));
  const src = ac.createBufferSource(); src.buffer = buf; const dest = ac.createMediaStreamDestination(); src.connect(dest);
  draw(ctx, m, 0, vo, size);
  const audioTracks = dest.stream.getAudioTracks();
  if (!audioTracks.length) throw new Error("this browser gave no audio track to record; not exporting a silent video");
  const stream = new MediaStream([...canvas.captureStream(FPS).getVideoTracks(), ...audioTracks]);
  const mime = ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 3_000_000 } : {});
  const parts: Blob[] = []; rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  const stopped = new Promise<void>((r) => { rec.onstop = () => r(); });
  await ac.resume(); rec.start(1000); const t0 = ac.currentTime + 0.05; src.start(t0);
  await new Promise<void>((resolve) => {
    const loop = () => {
      const t = ac.currentTime - t0;
      if (signal.aborted || t >= m.duration) return resolve();
      draw(ctx, m, Math.max(0, t), vo, size); set({ progress: exportProgress("video", t / m.duration) });
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  rec.stop(); await stopped; src.stop(); if (ac !== primed) await ac.close();
  if (signal.aborted) throw cancelled();
  const type = rec.mimeType || mime || "video/webm";
  return { blob: new Blob(parts, { type }), ext: type.includes("mp4") ? "mp4" : "webm", method: `MediaRecorder ${type.split(";")[0]} (real time)` };
}
