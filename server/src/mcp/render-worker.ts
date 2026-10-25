// Headless render worker thread: the app's own offline renderer (renderProjectOffline -> sf2-processor core) on the
// Node OfflineEnv. No browser, no AudioContext, no remote service. The default SoundFont is parsed once per worker;
// a job may name another SoundFont file (per-render selection), parsed on first use and cached by path.
// parent -> { type: "init", soundFontPath }              worker -> { type: "ready", soundFont } | { type: "init-error", message }
// parent -> { type: "render", jobId, project, options, soundFontPath?, soundFontLabel? }
//                                                        worker -> { type: "progress", jobId, progress }
//                                                                 | { type: "done", jobId, meta, bytes } (bytes transferred)
//                                                                 | { type: "error", jobId, code, message }
import { parentPort } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { parseSoundFont, type LoadedSoundFont } from "../../../src/audio/soundfont-loader.ts";
import { renderProjectOffline, type OfflineRenderOptions } from "../../../src/audio/offline-renderer.ts";
import { nodeOfflineEnv } from "../../../src/audio/node-offline-env.ts";
import type { Project } from "../../../src/workstation/model.ts";

let sf: LoadedSoundFont | null = null;
/** Parsed fonts by file path (the default font plus every per-job selection this worker has served). */
const fontsByPath = new Map<string, LoadedSoundFont>();
const env = nodeOfflineEnv();

function fontFor(path?: string, label?: string): LoadedSoundFont {
  if (!path) return sf!;
  let f = fontsByPath.get(path);
  if (!f) {
    f = parseSoundFont(new Uint8Array(readFileSync(path)), `server:${label ?? path}`, label ?? path.split("/").pop() ?? path);
    fontsByPath.set(path, f);
  }
  return f;
}

parentPort?.on("message", async (m: { type: string; soundFontPath?: string; soundFontLabel?: string; jobId?: string; project?: Project; options?: OfflineRenderOptions }) => {
  if (m.type === "init") {
    try {
      sf = parseSoundFont(new Uint8Array(readFileSync(m.soundFontPath!)), "server:GeneralUser-GS.sf2", "GeneralUser-GS.sf2");
      fontsByPath.set(m.soundFontPath!, sf);
      parentPort!.postMessage({ type: "ready", soundFont: { label: sf.label, bytes: sf.bytes, presets: sf.presetCount } });
    } catch (e) { parentPort!.postMessage({ type: "init-error", message: (e as Error).message }); }
    return;
  }
  if (m.type !== "render") return;
  const jobId = m.jobId!;
  try {
    if (!sf) throw new Error("soundfont not initialized");
    const jobFont = fontFor(m.soundFontPath, m.soundFontLabel);
    let last = 0;
    const r = await renderProjectOffline(m.project!, m.options!, undefined, (x) => {
      const now = Date.now(); if (now - last > 500) { last = now; parentPort!.postMessage({ type: "progress", jobId, progress: x }); }
    }, { soundFont: jobFont, offlineEnv: env });
    const buf = r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength) as ArrayBuffer;
    const meta = { sha256: r.sha256, byteLength: r.byteLength, validated: r.validated, durationSeconds: r.durationSeconds, peakDbFS: r.peakDbFS, rmsDbFS: r.rmsDbFS,
      clippedSamples: r.clippedSamples, loudness: r.loudness, instruments: r.instruments, warnings: r.warnings, soundFont: r.soundFont, noteCount: r.noteCount, renderMs: r.renderMs };
    parentPort!.postMessage({ type: "done", jobId, meta, bytes: buf }, [buf]);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    parentPort!.postMessage({ type: "error", jobId, code: err.code ?? "RENDER_FAILED", message: err.message ?? String(e) });
  }
});
