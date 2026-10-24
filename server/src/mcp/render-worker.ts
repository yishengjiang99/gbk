// Render worker thread: runs the canonical GBK offline renderer (renderProjectOffline -> Sf2SynthEngine)
// with NO browser, NO AudioContext and NO user session. The SoundFont is parsed once per worker and reused.
// Protocol (parent <-> worker):
//   parent -> { type: "init", soundFontPath }                    worker -> { type: "ready" } | { type: "init-error", message }
//   parent -> { type: "render", jobId, project, options }        worker -> { type: "progress", jobId, progress, stage }
//                                                                        | { type: "done", jobId, meta, bytes } (bytes transferred)
//                                                                        | { type: "error", jobId, code, message }
import { parentPort } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { parseSoundFont, type LoadedSoundFont } from "../../../src/audio/soundfont-loader.ts";
import { renderProjectOffline, type OfflineRenderOptions } from "../../../src/audio/offline-renderer.ts";
import type { Project } from "../../../src/workstation/model.ts";

let sf: LoadedSoundFont | null = null;

parentPort?.on("message", async (m: { type: string; soundFontPath?: string; jobId?: string; project?: Project; options?: OfflineRenderOptions }) => {
  if (m.type === "init") {
    try {
      sf = parseSoundFont(new Uint8Array(readFileSync(m.soundFontPath!)), "server-soundfont", "GeneralUser-GS.sf2");
      parentPort!.postMessage({ type: "ready" });
    } catch (e) { parentPort!.postMessage({ type: "init-error", message: (e as Error).message }); }
    return;
  }
  if (m.type === "render") {
    const jobId = m.jobId!;
    try {
      if (!sf) throw new Error("soundfont not initialized");
      const r = await renderProjectOffline(m.project!, m.options!, undefined, (x, stage) => {
        parentPort!.postMessage({ type: "progress", jobId, progress: x, stage });
      }, { soundFont: sf });
      const bytes = r.bytes;
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const meta = {
        sha256: r.sha256, durationSeconds: r.durationSeconds, musicSeconds: r.musicSeconds, tailSeconds: r.tailSeconds,
        sampleRate: r.sampleRate, channels: r.channels, format: r.format, framesRendered: r.framesRendered, byteLength: r.byteLength,
        peakDbFS: r.peakDbFS, rmsDbFS: r.rmsDbFS, clippedSamples: r.clippedSamples, gain: r.gain, validated: r.validated as true,
        loudness: r.loudness, instruments: r.instruments, warnings: r.warnings, soundFont: r.soundFont, noteCount: r.noteCount, renderMs: r.renderMs,
      };
      parentPort!.postMessage({ type: "done", jobId, meta, bytes: buf }, [buf]);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      parentPort!.postMessage({ type: "error", jobId, code: err.code ?? "RENDER_FAILED", message: err.message ?? String(e) });
    }
  }
});
