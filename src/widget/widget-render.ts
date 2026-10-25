import { DEFAULT_SOUNDFONT_PATH } from "../audio/soundfont-assets.ts";
// In-chat player renderer (ChatGPT / MCP Apps widget). Bundled by scripts/build-widget.mjs into ONE classic script
// served by the GBK server at /api/mcp/widget/gbk-widget-render.js; the widget HTML (server/src/mcp/ui.ts) loads it on
// demand and calls window.GbkWidgetRender.render(). Synthesis is the canonical browser path: renderProjectOffline ->
// OfflineAudioContext + sf2-processor AudioWorklet (offline-context.ts). The server never renders audio.
import { renderProjectOffline, type OfflineRenderOptions, type RenderResult, type ProgressFn } from "../audio/offline-renderer.ts";
import { loadSoundFont } from "../audio/soundfont-loader.ts";
import type { Project } from "../workstation/model.ts";
import { RenderError } from "../audio/render-error.ts";

type G = { __gbkSf2WorkletUrl?: string; OfflineAudioContext?: typeof OfflineAudioContext; webkitOfflineAudioContext?: typeof OfflineAudioContext };

/** Pick a worklet URL the sandbox accepts: our origin first (CSP resourceDomains), then a blob: copy of the same code. */
export async function prepareWorklet(base: string, signal?: AbortSignal): Promise<{ url: string; via: "origin" | "blob" }> {
  const g = globalThis as unknown as G;
  const Ctor = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
  if (!Ctor) throw new RenderError("RENDER_UNSUPPORTED", "this browser has no OfflineAudioContext");
  const probe = async (url: string) => { const c = new Ctor(1, 128, 44100); if (!c.audioWorklet) throw new RenderError("RENDER_UNSUPPORTED", "no AudioWorklet in OfflineAudioContext"); await c.audioWorklet.addModule(url); };
  const direct = `${base}/api/mcp/widget/sf2-processor.js`;
  const errors: string[] = [];
  try { await probe(direct); g.__gbkSf2WorkletUrl = direct; return { url: direct, via: "origin" }; } catch (e) { errors.push(`origin: ${(e as Error).message}`); }
  try {
    const res = await fetch(direct, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const url = URL.createObjectURL(new Blob([await res.text()], { type: "text/javascript" }));
    await probe(url); g.__gbkSf2WorkletUrl = url; return { url, via: "blob" };
  } catch (e) { errors.push(`blob: ${(e as Error).message}`); }
  throw new RenderError("RENDER_UNSUPPORTED", `this player cannot load the SF2 audio worklet here (${errors.join("; ")})`);
}

export interface WidgetRenderInput {
  /** Server origin, e.g. https://compose.grepawk.com (worklet + SoundFont come from here). */
  base: string; project: Project; options: OfflineRenderOptions; signal?: AbortSignal;
  onProgress?: (fraction: number, stage: string) => void;
}

/** Render a composition snapshot to a validated WAV in this browser. Progress: 0-0.4 SoundFont download, 0.4-1 synthesis/encode. */
export async function render(i: WidgetRenderInput): Promise<RenderResult & { worklet: "origin" | "blob" }> {
  const report = i.onProgress ?? (() => undefined);
  report(0, "worklet");
  const w = await prepareWorklet(i.base, i.signal);
  const soundFont = await loadSoundFont({ url: `${i.base}/api/mcp/widget/soundfont.sf2?v=${DEFAULT_SOUNDFONT_PATH.match(/\.([0-9a-f]{12})\.sf2$/)?.[1] ?? ""}`, signal: i.signal, timeoutMs: 180_000,
    onProgress: (l, t) => report(t ? 0.4 * (l / t) : 0.05, "soundfont") });
  const prog: ProgressFn = (p, stage) => report(stage === "loading" || stage === "resolving" ? 0.4 : 0.4 + 0.6 * Math.max(0, Math.min(1, p)), stage);
  const r = await renderProjectOffline(i.project, i.options, i.signal, prog, { soundFont });
  return { ...r, worklet: w.via };
}

export const version = 1;
(globalThis as unknown as { GbkWidgetRender?: unknown }).GbkWidgetRender = { render, prepareWorklet, version };
