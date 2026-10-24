// Persistent render artifacts (WAV / MIDI bytes + metadata) in IndexedDB, with an in-memory backend for
// runtimes without IndexedDB (tests). Artifacts survive reloads; in-progress jobs are NOT artifacts.
import { RenderError, asRenderError } from "./render-error.ts";

export interface ArtifactMeta {
  id: string; kind: "wav" | "midi"; filename: string; mimeType: string; bytes: number; sha256: string;
  createdAt: number; projectId: string; projectName: string; revision: number; jobId?: string;
  wav?: { durationSeconds: number; sampleRate: number; channels: number; format: string; frames: number; peakDbFS: number; rmsDbFS: number; clippedSamples: number; validated: boolean; loudness?: import("./loudness.ts").LoudnessReport };
}
export interface ArtifactBackend {
  put(meta: ArtifactMeta, blob: Blob): Promise<void>;
  getMeta(id: string): Promise<ArtifactMeta | null>;
  getBlob(id: string): Promise<Blob | null>;
  list(): Promise<ArtifactMeta[]>;
  delete(id: string): Promise<void>;
}

export class MemoryArtifactBackend implements ArtifactBackend {
  private m = new Map<string, { meta: ArtifactMeta; blob: Blob }>();
  /** Test hook: simulate a storage quota failure on the next put. */
  failNextPut: Error | null = null;
  async put(meta: ArtifactMeta, blob: Blob) { if (this.failNextPut) { const e = this.failNextPut; this.failNextPut = null; throw e; } this.m.set(meta.id, { meta, blob }); }
  async getMeta(id: string) { return this.m.get(id)?.meta ?? null; }
  async getBlob(id: string) { return this.m.get(id)?.blob ?? null; }
  async list() { return [...this.m.values()].map((x) => x.meta).sort((a, b) => b.createdAt - a.createdAt); }
  async delete(id: string) { this.m.delete(id); }
}

const DB = "gbk-render-artifacts";
export class IdbArtifactBackend implements ArtifactBackend {
  private db: Promise<IDBDatabase> | null = null;
  private open(): Promise<IDBDatabase> {
    return this.db ??= new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("meta", { keyPath: "id" }); r.result.createObjectStore("blobs"); };
      r.onsuccess = () => res(r.result); r.onerror = () => { this.db = null; rej(new RenderError("STORAGE_UNAVAILABLE", `IndexedDB unavailable: ${r.error?.message}`)); };
    });
  }
  private async tx<T>(stores: string[], mode: IDBTransactionMode, f: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
    const db = await this.open();
    return new Promise<T>((res, rej) => {
      const t = db.transaction(stores, mode); let out: T;
      const req = f(t); if (req) req.onsuccess = () => { out = req.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(asRenderError(t.error, "STORAGE_UNAVAILABLE")); t.onabort = () => rej(asRenderError(t.error ?? new Error("transaction aborted"), "STORAGE_UNAVAILABLE"));
    });
  }
  /** Session-only fallback when this browser's IndexedDB refuses to store the bytes (Safari Private Browsing / Lockdown). */
  private mem = new MemoryArtifactBackend(); private memOnly = false;
  async put(meta: ArtifactMeta, blob: Blob) {
    if (this.memOnly) return this.mem.put(meta, blob);
    try { await this.tx(["meta", "blobs"], "readwrite", (t) => { t.objectStore("blobs").put(blob, meta.id); t.objectStore("meta").put(meta); }); return; }
    catch (e) { if (asRenderError(e).code === "QUOTA_EXCEEDED" || /quota/i.test((e as Error).message ?? "")) throw e; }
    // Some WebKit builds cannot persist Blob values in IndexedDB: store the raw bytes instead.
    try { const buf = await blob.arrayBuffer(); await this.tx(["meta", "blobs"], "readwrite", (t) => { t.objectStore("blobs").put({ buf, type: blob.type }, meta.id); t.objectStore("meta").put(meta); }); return; }
    catch (e) { if (asRenderError(e).code === "QUOTA_EXCEEDED" || /quota/i.test((e as Error).message ?? "")) throw e; }
    this.memOnly = true; await this.mem.put(meta, blob);
  }
  async getMeta(id: string) { if (this.memOnly) { const m = await this.mem.getMeta(id); if (m) return m; } return (await this.tx<ArtifactMeta | undefined>(["meta"], "readonly", (t) => t.objectStore("meta").get(id))) ?? null; }
  async getBlob(id: string) {
    if (this.memOnly) { const b = await this.mem.getBlob(id); if (b) return b; }
    const v = await this.tx<Blob | { buf: ArrayBuffer; type: string } | undefined>(["blobs"], "readonly", (t) => t.objectStore("blobs").get(id));
    if (!v) return null; return v instanceof Blob ? v : new Blob([v.buf], { type: v.type });
  }
  async list() { const idb = ((await this.tx<ArtifactMeta[]>(["meta"], "readonly", (t) => t.objectStore("meta").getAll())) ?? []); return [...(this.memOnly ? await this.mem.list() : []), ...idb].sort((a, b) => b.createdAt - a.createdAt); }
  async delete(id: string) { await this.mem.delete(id); await this.tx(["meta", "blobs"], "readwrite", (t) => { t.objectStore("meta").delete(id); t.objectStore("blobs").delete(id); }); }
}

export const MAX_CHUNK_BYTES = 256 * 1024;

export class ArtifactStore {
  private urls = new Map<string, string>();
  private listeners = new Set<() => void>();
  constructor(public backend: ArtifactBackend) {}
  subscribe(f: () => void) { this.listeners.add(f); return () => { this.listeners.delete(f); }; }
  private emit() { for (const f of this.listeners) f(); }
  async save(meta: Omit<ArtifactMeta, "id" | "createdAt" | "bytes"> & { id?: string }, blob: Blob): Promise<ArtifactMeta> {
    const full: ArtifactMeta = { ...meta, id: meta.id ?? `${meta.kind}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now(), bytes: blob.size };
    try { await this.backend.put(full, blob); } catch (e) {
      const err = asRenderError(e, "STORAGE_UNAVAILABLE");
      if (err.code === "QUOTA_EXCEEDED" || /quota/i.test(err.message)) throw new RenderError("QUOTA_EXCEEDED", `browser storage quota exceeded while saving ${full.filename} (${blob.size} bytes); free space by deleting artifacts`);
      throw err;
    }
    // Verify the bytes really landed.
    const back = await this.backend.getMeta(full.id);
    if (!back) throw new RenderError("STORAGE_UNAVAILABLE", "artifact was not persisted");
    this.emit();
    return full;
  }
  list() { return this.backend.list(); }
  async meta(id: string) { const m = await this.backend.getMeta(id); if (!m) throw new RenderError("ARTIFACT_NOT_FOUND", `unknown artifact ${id}`); return m; }
  async blob(id: string) { const b = await this.backend.getBlob(id); if (!b) throw new RenderError("ARTIFACT_NOT_FOUND", `unknown artifact ${id}`); return b; }
  /** Bounded byte range (never more than MAX_CHUNK_BYTES); never silently truncated: length is exact unless EOF. */
  async readRange(id: string, offset: number, length: number): Promise<{ bytes: Uint8Array; offset: number; total: number; eof: boolean }> {
    if (!(Number.isInteger(offset) && offset >= 0)) throw new RenderError("INVALID_ARGUMENT", "offset must be a non-negative integer");
    if (!(Number.isInteger(length) && length > 0 && length <= MAX_CHUNK_BYTES)) throw new RenderError("INVALID_ARGUMENT", `length must be in [1, ${MAX_CHUNK_BYTES}]`);
    const b = await this.blob(id);
    if (offset > b.size) throw new RenderError("INVALID_ARGUMENT", `offset ${offset} beyond end (${b.size})`);
    const bytes = new Uint8Array(await b.slice(offset, Math.min(b.size, offset + length)).arrayBuffer());
    return { bytes, offset, total: b.size, eof: offset + bytes.length >= b.size };
  }
  /** Same-origin object URL (revoked on delete / revokeAll). */
  async objectUrl(id: string): Promise<string> {
    const hit = this.urls.get(id); if (hit) return hit;
    if (typeof URL.createObjectURL !== "function") throw new RenderError("STORAGE_UNAVAILABLE", "object URLs unsupported in this runtime");
    const u = URL.createObjectURL(await this.blob(id)); this.urls.set(id, u); return u;
  }
  revokeAll() { for (const u of this.urls.values()) URL.revokeObjectURL?.(u); this.urls.clear(); }
  async delete(id: string) { await this.meta(id); const u = this.urls.get(id); if (u) { URL.revokeObjectURL?.(u); this.urls.delete(id); } await this.backend.delete(id); this.emit(); }
}

const g = globalThis as { __gbkArtifacts?: ArtifactStore };
export function artifactStore(): ArtifactStore {
  return g.__gbkArtifacts ??= new ArtifactStore(typeof indexedDB !== "undefined" ? new IdbArtifactBackend() : new MemoryArtifactBackend());
}
export function setArtifactStore(s: ArtifactStore) { g.__gbkArtifacts = s; }

export function base64(bytes: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString("base64");
  let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
