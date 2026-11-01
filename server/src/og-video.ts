// iMessage won't play og:audio inline, but it plays an og:video. Render the song's OG card PNG plus its MP3
// into a still-image H.264/AAC MP4 (yuv420p, main profile, +faststart). Cached on disk next to the PNG,
// keyed by the PNG file (slug + revision) and a hash of the MP3, so a new card or new audio re-renders.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const ogVideoEnabled = (env: NodeJS.ProcessEnv = process.env) => env.OG_VIDEO_ENABLED !== "0";
const inflight = new Map<string, Promise<string>>();

/** Returns the cached MP4 path; renders once per (card, audio) and shares one render among concurrent callers. */
export function ogVideo(dir: string, slug: string, pngPath: string, mp3: Uint8Array, ffmpeg = "ffmpeg"): Promise<string> {
  const key = createHash("sha1").update(basename(pngPath)).update(mp3).update("v1").digest("hex").slice(0, 16);
  const file = join(dir, `${slug.replace(/[^a-zA-Z0-9-]/g, "_")}-${key}.mp4`);
  if (existsSync(file)) return Promise.resolve(file);
  const running = inflight.get(file); if (running) return running;
  const p = new Promise<string>((resolve, reject) => {
    mkdirSync(dir, { recursive: true });
    const tag = `${process.pid}-${Date.now()}`, audio = `${file}.${tag}.mp3`, tmp = `${file}.${tag}.tmp.mp4`;
    writeFileSync(audio, mp3);
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "10", "-i", pngPath, "-i", audio,
      "-map", "0:v:0", "-map", "1:a:0", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
      "-c:v", "libx264", "-profile:v", "main", "-tune", "stillimage", "-preset", "veryfast", "-r", "10", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-shortest", "-t", "600", "-movflags", "+faststart", "-f", "mp4", tmp];
    execFile(ffmpeg, args, { timeout: 180_000, maxBuffer: 1 << 20 }, (err) => {
      rmSync(audio, { force: true });
      if (err) { rmSync(tmp, { force: true }); return reject(err); }
      renameSync(tmp, file); resolve(file);
    });
  }).finally(() => inflight.delete(file));
  inflight.set(file, p);
  return p;
}
