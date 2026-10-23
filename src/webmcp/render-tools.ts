// WebMCP rendering + artifact tools. Rendering is headless (src/audio): no click, no unlocked AudioContext, no
// Player / Library, no live preset. Results are returned only after rendering + validation; long renders expose a
// real job id. Audio bytes never go into JSON text: small files can be returned as MCP audio content (when the host
// supports it), otherwise as a persisted artifact read with bounded, offset-based gbk_read_wav_bytes chunks.
import type { WorkstationController } from "../workstation/controller.ts";
import { WorkstationError } from "../workstation/ops.ts";
import { renderJobs, safeFilename, type RenderJob } from "../audio/render-job.ts";
import { artifactStore, base64, MAX_CHUNK_BYTES, type ArtifactMeta } from "../audio/artifact-store.ts";
import { RenderError } from "../audio/render-error.ts";
import { sha256Hex } from "../audio/offline-renderer.ts";
import type { ToolDef, JsonSchema, ToolContent } from "./tools.ts";

const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
const str = (d?: string): JsonSchema => ({ type: "string", maxLength: 200, ...(d ? { description: d } : {}) });

/** Largest WAV returned inline as MCP audio content / base64 (bigger results become artifact references). */
export const INLINE_AUDIO_MAX = 4 * 1024 * 1024;
export const INLINE_BYTES_MAX = MAX_CHUNK_BYTES;

const err = (e: RenderError | { code: string; message: string }) => new WorkstationError(e.code, e.message);

export function jobView(j: RenderJob) {
  const r = j.result;
  return {
    jobId: j.id, projectId: j.projectId, revision: j.revision, status: j.status, progress: Math.round(j.progress * 100), artifactId: j.artifactId ?? null, error: j.error ?? null,
    ...(r ? { filename: safeFilename(j.projectName, "wav"), durationSeconds: +r.durationSeconds.toFixed(3), musicSeconds: +r.musicSeconds.toFixed(3), tailSeconds: r.tailSeconds, sampleRate: r.sampleRate, channels: r.channels, format: r.format, frames: r.framesRendered, bytes: r.byteLength, sha256: r.sha256,
      peakDbFS: r.peakDbFS, rmsDbFS: r.rmsDbFS, clippedSamples: r.clippedSamples, validated: r.validated, instruments: r.instruments, soundFont: r.soundFont, renderMs: r.renderMs, loudness: r.loudness, warnings: r.warnings } : {}),
  };
}
const artifactView = (a: ArtifactMeta) => ({ artifactId: a.id, kind: a.kind, filename: a.filename, mimeType: a.mimeType, bytes: a.bytes, sha256: a.sha256, createdAt: new Date(a.createdAt).toISOString(), projectId: a.projectId, projectName: a.projectName, revision: a.revision, jobId: a.jobId ?? null, wav: a.wav ?? null });

async function waitFor(id: string, ms: number, signal: AbortSignal): Promise<RenderJob> {
  const jobs = renderJobs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((res) => { timer = setTimeout(() => res(null), ms); });
  const aborted = new Promise<null>((res) => signal.addEventListener("abort", () => res(null), { once: true }));
  const r = await Promise.race([jobs.wait(id), timeout, aborted]);
  clearTimeout(timer);
  return r ?? jobs.get(id);
}

export function buildRenderTools(c: WorkstationController): ToolDef[] {
  const store = () => artifactStore();
  return [
    { name: "gbk_render_wav", readOnly: false,
      description: "Render the committed project to a validated WAV with the SF2 engine, fully headless (no click, no audio unlock, no Player, no pre-loaded SoundFont; GeneralUser GS loads automatically). Snapshot semantics: later edits do not affect the render. output: artifact (default; saved in browser storage, read bytes with gbk_read_wav_bytes), audio (MCP audio content when small and supported, else artifact reference), bytes (inline base64 only if <= 256 KiB, else artifact reference). download defaults to false and never happens unless true. Returns ok only after render + validation; if it takes longer than waitSeconds you get a real jobId to poll with gbk_get_render_status.",
      inputSchema: obj({ sampleRate: { type: "integer", enum: [44100, 48000] }, channels: { type: "integer", enum: [1, 2] }, format: { type: "string", enum: ["pcm16", "float32"] }, tailSeconds: { type: "number", minimum: 0, maximum: 30 },
        normalize: { anyOf: [{ type: "string", enum: ["loudness", "peak", "off"] }, { type: "boolean" }], description: "whole-file level (true = peak, false = off), one gain for the entire file (dynamics preserved): loudness (default) = -16 LUFS integrated capped at -1 dBTP; peak = -1 dBTP; off = raw engine output" },
        targetLufs: { type: "number", minimum: -40, maximum: -5, description: "integrated loudness target for normalize=loudness (default -16)" },
        autoPan: { type: "boolean", description: "orchestra-seating auto-pan, only for tracks without an explicit pan (mix pan or CC10); default false" },
        saveArtifact: { type: "boolean" }, download: { type: "boolean" }, output: { type: "string", enum: ["artifact", "audio", "bytes"] }, waitSeconds: { type: "number", minimum: 0, maximum: 600, description: "how long this call waits for completion (default 300)" },
        allowSilence: { type: "boolean" }, silenceThresholdDbFS: { type: "number", minimum: -140, maximum: 0 }, includeMidi: { type: "boolean", description: "also save the MIDI export as an artifact (default true)" } }),
      run: async (a, signal) => {
        const p = c.project;
        const output = (a.output as string) ?? "artifact";
        // audio output always keeps an artifact so a text-only host can fall back to it.
        const save = output === "bytes" ? (a.saveArtifact as boolean) ?? true : true;
        const job = renderJobs().submit(p, { sampleRate: (a.sampleRate as 44100) ?? 44100, channels: (a.channels as 2) ?? 2, format: (a.format as "pcm16") ?? "pcm16", tailSeconds: (a.tailSeconds as number) ?? 3, normalize: (typeof a.normalize === "boolean" ? a.normalize : (a.normalize as "loudness" | undefined)), targetLufs: a.targetLufs as number | undefined, autoPan: a.autoPan as boolean | undefined, allowSilence: !!a.allowSilence, silenceThresholdDbFS: a.silenceThresholdDbFS as number | undefined }, { saveArtifact: save, signal });
        let midiArtifactId: string | null = null; const warnings: string[] = [];
        if (a.includeMidi !== false) {
          try { const { bytes, filename } = c.prepareMidiExport(); midiArtifactId = (await store().save({ kind: "midi", filename, mimeType: "audio/midi", sha256: await sha256Hex(bytes), projectId: p.id, projectName: p.name, revision: p.revision }, new Blob([bytes as BlobPart], { type: "audio/midi" }))).id; }
          catch (e) { warnings.push(`MIDI artifact not saved: ${(e as Error).message}`); }
        }
        const j = await waitFor(job.id, ((a.waitSeconds as number) ?? 300) * 1000, signal);
        if (signal.aborted) { renderJobs().cancel(job.id); throw new WorkstationError("OPERATION_CANCELLED", "render cancelled"); }
        if (j.status === "failed" || j.status === "cancelled") throw new WorkstationError(j.error?.code ?? "INTERNAL_ERROR", j.error?.message ?? `render ${j.status}`, { jobId: j.id });
        if (j.status !== "completed") return { data: { ...jobView(j), midiArtifactId, next: "Render still running: poll gbk_get_render_status with this jobId." }, warnings };
        const view = { ...jobView(j), midiArtifactId };
        warnings.push(...(j.result?.warnings ?? []));
        let downloaded: unknown = undefined;
        if (a.download === true) {
          const res = renderJobs().result(j.id);
          if (!res || !c.host.download) downloaded = { requested: false, reason: "no browser download handler" };
          else { const ok = c.host.download(res.blob, safeFilename(j.projectName, "wav")); downloaded = { requested: ok !== false, confirmed: false, note: "browsers do not report whether a download was allowed; the artifact stays available either way" }; }
        }
        const res = renderJobs().result(j.id);
        if (output === "audio") {
          if (res && res.byteLength <= INLINE_AUDIO_MAX) return { data: { ...view, output: "audio", downloaded }, warnings, content: [{ type: "audio", mimeType: "audio/wav", data: base64(res.bytes) }] };
          return { data: { ...view, output: "artifact", downloaded, audioInline: false, reason: `WAV is ${view.bytes} bytes, over the ${INLINE_AUDIO_MAX}-byte inline audio limit; read it with gbk_read_wav_bytes` }, warnings };
        }
        if (output === "bytes") {
          if (res && res.byteLength <= INLINE_BYTES_MAX) return { data: { ...view, output: "bytes", downloaded, encoding: "base64", base64: base64(res.bytes) }, warnings };
          return { data: { ...view, output: "artifact", downloaded, bytesInline: false, reason: `WAV is ${view.bytes} bytes (> ${INLINE_BYTES_MAX}); read it in chunks with gbk_read_wav_bytes (offset/length) and verify sha256` }, warnings };
        }
        return { data: { ...view, output: "artifact", downloaded, read: { tool: "gbk_read_wav_bytes", maxChunkBytes: MAX_CHUNK_BYTES } }, warnings };
      } },
    { name: "gbk_get_render_status", readOnly: true, description: "Status of a render job (queued, loading, rendering, encoding, validating, saving, completed, failed, cancelled), progress %, errors and artifact id. Jobs live in this page only (not durable across reloads; artifacts are).",
      inputSchema: obj({ jobId: str() }, ["jobId"]),
      run: (a) => { try { return { data: jobView(renderJobs().get(a.jobId as string)) }; } catch (e) { throw err(e as RenderError); } } },
    { name: "gbk_cancel_render", readOnly: false, description: "Cancel a queued or running render job (no partial artifact is saved).", inputSchema: obj({ jobId: str() }, ["jobId"]),
      run: (a) => { try { return { data: { cancelled: renderJobs().cancel(a.jobId as string) } }; } catch (e) { throw err(e as RenderError); } } },
    { name: "gbk_list_render_artifacts", readOnly: true, description: "Saved WAV / MIDI artifacts (persisted in browser storage) with metadata, timestamps and project ids, newest first.",
      inputSchema: obj({ projectId: str(), kind: { type: "string", enum: ["wav", "midi"] }, limit: { type: "integer", minimum: 1, maximum: 200 } }),
      run: async (a) => { const all = (await store().list()).filter((x) => (!a.projectId || x.projectId === a.projectId) && (!a.kind || x.kind === a.kind)); return { data: { total: all.length, artifacts: all.slice(0, (a.limit as number) ?? 50).map(artifactView) } }; } },
    { name: "gbk_get_render_artifact", readOnly: true, description: "Metadata of one artifact plus a same-origin object URL usable inside this page, and how to transfer the bytes (gbk_read_wav_bytes). Never returns the audio itself.",
      inputSchema: obj({ artifactId: str() }, ["artifactId"]),
      run: async (a) => {
        try { const m = await store().meta(a.artifactId as string); let url: string | null = null; try { url = await store().objectUrl(m.id); } catch { /* non-browser */ }
          return { data: { ...artifactView(m), objectUrl: url, objectUrlScope: "same-origin, this page only; not reachable from other processes", read: { tool: "gbk_read_wav_bytes", maxChunkBytes: MAX_CHUNK_BYTES, chunks: Math.ceil(m.bytes / MAX_CHUNK_BYTES) } } }; }
        catch (e) { throw err(e as RenderError); }
      } },
    { name: "gbk_read_wav_bytes", readOnly: true, description: `Bounded byte transfer of a saved artifact: base64 of [offset, offset+length) with length <= ${MAX_CHUNK_BYTES}. Repeat with nextOffset until eof, concatenate, and compare SHA-256 with the artifact's sha256. Never truncates silently: returned length is exact except at end of file.`,
      inputSchema: obj({ artifactId: str(), offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, length: { type: "integer", minimum: 1, maximum: MAX_CHUNK_BYTES } }, ["artifactId"]),
      run: async (a) => {
        try { const m = await store().meta(a.artifactId as string); const r = await store().readRange(m.id, (a.offset as number) ?? 0, (a.length as number) ?? MAX_CHUNK_BYTES);
          return { data: { artifactId: m.id, offset: r.offset, length: r.bytes.length, total: r.total, eof: r.eof, nextOffset: r.eof ? null : r.offset + r.bytes.length, sha256: m.sha256, mimeType: m.mimeType, encoding: "base64", base64: base64(r.bytes) } }; }
        catch (e) { throw err(e as RenderError); }
      } },
    { name: "gbk_download_render_artifact", readOnly: false, description: "Start a browser download of a saved artifact. Reports requested=true when the download was initiated; browsers do not confirm whether it was allowed, so this never claims the file reached disk. The artifact stays in the workstation's artifact panel either way.",
      inputSchema: obj({ artifactId: str() }, ["artifactId"]),
      run: async (a) => {
        try { const m = await store().meta(a.artifactId as string); const b = await store().blob(m.id);
          if (!c.host.download) throw new RenderError("DOWNLOAD_BLOCKED", "no download mechanism in this runtime; use gbk_read_wav_bytes");
          const ok = c.host.download(b, m.filename);
          if (ok === false) throw new RenderError("DOWNLOAD_BLOCKED", "the browser refused to start the download; use the artifact panel link or gbk_read_wav_bytes");
          return { data: { artifactId: m.id, filename: m.filename, requested: true, confirmed: false } }; }
        catch (e) { throw err(e as RenderError); }
      } },
    { name: "gbk_delete_render_artifact", readOnly: false, description: "Delete a saved artifact from browser storage.", inputSchema: obj({ artifactId: str() }, ["artifactId"]),
      run: async (a) => { try { await store().delete(a.artifactId as string); return { data: { deleted: a.artifactId } }; } catch (e) { throw err(e as RenderError); } } },
  ];
}
export type { ToolContent };
