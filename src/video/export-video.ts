// In-browser "Export video": offline SF2 render (same path as Export WAV) + moving piano roll frames on a canvas,
// encoded with WebCodecs (H.264 + AAC/Opus) into MP4 via mp4-muxer. Fallback: MediaRecorder in real time
// (canvas.captureStream + the rendered audio), for browsers without VideoEncoder/AudioEncoder.
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import type { Project } from "../workstation/model.ts";
import { renderJobs, safeFilename } from "../audio/render-job.ts";
import { buildVideoModel, drawFrame, type VideoModel, type VideoOptions } from "./piano-roll-video.ts";
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
  try {
    const job = renderJobs().submit(project, { sampleRate: 48000, channels: 2, format: "pcm16", tailSeconds: 2 }, { saveArtifact: false, signal });
    const unsub = renderJobs().subscribe((j) => { if (j.id === job.id) set({ progress: exportProgress("audio", j.progress) }); });
    const done = await renderJobs().wait(job.id).finally(unsub);
    if (signal.aborted || done.status === "cancelled") throw cancelled();
    if (done.status !== "completed") throw new Error(`audio render ${done.status}: ${done.error?.message ?? ""}`);
    const r = renderJobs().result(job.id); if (!r) throw new Error("audio render result missing");
    const audio = parseWav(r.bytes);
    const duration = audio.channels[0].length / audio.sampleRate;
    const model = buildVideoModel(project, duration, `${project.tracks.length} tracks · GBK Composer`);
    const size = evenSize(opts.height ?? 720);
    const vo: VideoOptions = { ...LOGICAL, fps: FPS, windowSeconds: 8, playheadFrac: 0.3, theme: "light" };
    set({ stage: "Encoding video" });
    let out: { blob: Blob; ext: string; method: string };
    const wc = await pickWebCodecs(size, audio.sampleRate, audio.channels.length);
    if (wc) out = await encodeWebCodecs(model, vo, size, audio, wc, signal);
    else if (typeof MediaRecorder !== "undefined") out = await encodeMediaRecorder(model, vo, size, audio, signal, primed);
    else throw new Error("This browser cannot encode video (no WebCodecs or MediaRecorder)");
    const filename = safeFilename(project.name, out.ext);
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

type Size = { width: number; height: number };
interface WcPlan { video: VideoEncoderConfig; audio: AudioEncoderConfig; audioCodec: "aac" | "opus" }

async function pickWebCodecs(size: Size, sampleRate: number, channels: number): Promise<WcPlan | null> {
  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined" || typeof VideoFrame === "undefined" || typeof AudioData === "undefined") return null;
  let video: VideoEncoderConfig | null = null;
  // H.264 High / Main / Baseline (level 3.1 covers 720p30). Safari and Chrome both encode avc1.
  for (const codec of ["avc1.640028", "avc1.4d401f", "avc1.42001f"]) {
    const c: VideoEncoderConfig = { codec, width: size.width, height: size.height, bitrate: 3_000_000, framerate: FPS, avc: { format: "avc" } };
    try { if ((await VideoEncoder.isConfigSupported(c)).supported) { video = c; break; } } catch { /* try next */ }
  }
  if (!video) return null;
  for (const [codec, audioCodec] of [["mp4a.40.2", "aac"], ["opus", "opus"]] as const) {
    const c: AudioEncoderConfig = { codec, sampleRate, numberOfChannels: channels, bitrate: 160_000 };
    try { if ((await AudioEncoder.isConfigSupported(c)).supported) return { video, audio: c, audioCodec }; } catch { /* try next */ }
  }
  return null;
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
  const aenc = new AudioEncoder({ output: (c, meta) => muxer.addAudioChunk(c, meta), error: (e) => { failure = e as Error; } });
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
    const { c, ctx } = makeCanvas(size);
    const frames = exportFrameCount(m.duration, FPS);
    for (let i = 0; i < frames; i++) {
      if (signal.aborted) throw cancelled(); if (failure) throw failure;
      draw(ctx, m, i / FPS, vo, size);
      const vf = new VideoFrame(c as CanvasImageSource, { timestamp: frameTimestampUs(i, FPS), duration: frameDurationUs(i, FPS) });
      venc.encode(vf, { keyFrame: i % (FPS * 2) === 0 }); vf.close();
      while (venc.encodeQueueSize > 6) await tick();
      if (i % 15 === 0) { set({ progress: exportProgress("video", i / frames) }); await tick(); }
    }
    await venc.flush(); await aenc.flush(); if (failure) throw failure;
    muxer.finalize();
    return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), ext: "mp4", method: `WebCodecs H.264 + ${plan.audioCodec.toUpperCase()}` };
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
  const stream = new MediaStream([...canvas.captureStream(FPS).getVideoTracks(), ...dest.stream.getAudioTracks()]);
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
