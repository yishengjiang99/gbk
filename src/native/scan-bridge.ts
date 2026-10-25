// iOS app (ios/GBKComposer/Features/Scan) <-> studio contract for "Scan sheet music".
// The app injects window.gbkNative (capabilities includes "scan", .scan = true); the studio then shows a Scan item, posts
// {type: "scan.start", project} to webkit.messageHandlers.gbkScan, and the app answers by calling
// window.gbkStudio.applyNativeOps(ops) with the same ops humToOps emits (addTrack + addNotes, plus
// setTempoMap/setTimeSigMap/setMeta on an empty song). See docs/ios/scan.md.
import type { Op } from "../workstation/ops.ts";
import type { Project } from "../workstation/model.ts";

export interface NativeScanProject { ppq: number; channels: number[]; noteCount: number; readOnly: boolean; readOnlyReason?: string }
export interface NativeApplyResult { ok: boolean; revision?: number; error?: string }

interface Editor {
  project: Project;
  readOnlyReason: string | null;
  userEdit(ops: Op[], opts?: { label?: string }): { revision: number } | null;
}

type Handler = { postMessage(body: unknown): void };
declare global {
  interface Window {
    gbkNative?: { scan?: boolean; capabilities?: string[]; [k: string]: unknown };
    gbkStudio?: { applyNativeOps(ops: Op[], opts?: { label?: string; source?: string }): NativeApplyResult; [k: string]: unknown };
    webkit?: { messageHandlers?: Record<string, Handler | undefined> };
  }
}

export function nativeScanAvailable(w: Window = window): boolean {
  const n = w.gbkNative;
  return !!(n?.scan || (Array.isArray(n?.capabilities) && n.capabilities.includes("scan"))) && !!w.webkit?.messageHandlers?.gbkScan;
}

export function scanProjectInfo(ed: Editor): NativeScanProject {
  const p = ed.project;
  return {
    ppq: p.ppq, channels: [...new Set(p.tracks.map((t) => t.channel))], noteCount: p.notes.length,
    readOnly: !!ed.readOnlyReason, ...(ed.readOnlyReason ? { readOnlyReason: ed.readOnlyReason } : {}),
  };
}

const ALLOWED = new Set(["addTrack", "addNotes", "setTempoMap", "setTimeSigMap", "setMeta"]);

/** Applies native ops as one undoable user edit. Only the op kinds Scan emits are accepted. */
export function applyNativeOps(ed: Editor, ops: unknown, label = "scan sheet music"): NativeApplyResult {
  if (!Array.isArray(ops) || !ops.length) return { ok: false, error: "no ops" };
  const bad = ops.find((o) => !o || typeof o !== "object" || !ALLOWED.has((o as { op?: string }).op ?? ""));
  if (bad) return { ok: false, error: `unsupported op ${(bad as { op?: string })?.op ?? "?"}` };
  if (ed.readOnlyReason) return { ok: false, error: `READ_ONLY: ${ed.readOnlyReason}` };
  try {
    const r = ed.userEdit(ops as Op[], { label });
    return r ? { ok: true, revision: r.revision } : { ok: false, error: "READ_ONLY" };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function installStudioBridge(ed: Editor, w: Window = window): void {
  w.gbkStudio = Object.assign(w.gbkStudio ?? {}, {
    applyNativeOps: (ops: Op[], opts?: { label?: string }) => applyNativeOps(ed, ops, opts?.label),
  });
}

export function startNativeScan(ed: Editor, w: Window = window): boolean {
  const h = w.webkit?.messageHandlers?.gbkScan;
  if (!h) return false;
  h.postMessage({ type: "scan.start", project: scanProjectInfo(ed) });
  return true;
}
