/**
 * On-device persistence for user-added MIDI files.
 *
 * MIDI files added via the "+" transport button ("upload") and via camera
 * scans ("scan") are stored as binary in IndexedDB so they survive reloads
 * and app restarts. Bundled demo files are not stored here — they ship with
 * the app and are re-fetched from the static manifest.
 *
 * Design notes:
 * - One database ("gbk-midi"), two object stores: "files" (keyPath "id")
 *   holds the raw MIDI bytes, "meta" (keyPath "key") holds the ordered
 *   playlist so entries restore in the order they were added.
 * - Scan photos and OCR note layouts are intentionally NOT persisted; only
 *   the MIDI bytes are (see task scope).
 * - Every public method is failure-safe: when IndexedDB is unavailable or a
 *   request fails, the call resolves to a graceful default (null / [] / void)
 *   with a console warning, so playback and the UI never break.
 */

/** Where a stored MIDI file came from. */
export type StoredMidiSource = "upload" | "scan";

/** One user-added MIDI file stored in IndexedDB. */
export interface StoredMidiFile {
  /** Stable id, also used as the playlist entry id. */
  id: string;
  /** Display name, e.g. "song.mid" or "Scanned sheet — 9/25/2026, 8:29:50 PM". */
  name: string;
  /** Raw MIDI file bytes. */
  bytes: ArrayBuffer;
  source: StoredMidiSource;
  /** Date.now() when the file was stored. */
  createdAt: number;
}

/** Minimal playlist entry metadata (binary lives in the "files" store). */
export interface StoredPlaylistEntryMeta {
  id: string;
  name: string;
}

/** Ordered playlist of user-added files, persisted in the "meta" store. */
export interface StoredPlaylistMeta {
  version: 1;
  uploads: StoredPlaylistEntryMeta[];
  scans: StoredPlaylistEntryMeta[];
}

const DB_NAME = "gbk-midi";
const DB_VERSION = 1;
const FILES_STORE = "files";
const META_STORE = "meta";
const PLAYLIST_META_KEY = "playlist";

function warn(message: string, err?: unknown): void {
  if (err !== undefined) console.warn(`[midi-file-store] ${message}`, err);
  else console.warn(`[midi-file-store] ${message}`);
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error instanceof Error ? request.error : new Error("IndexedDB request failed"));
  });
}

function isValidPlaylistMeta(value: unknown): value is StoredPlaylistMeta {
  if (value == null || typeof value !== "object") return false;
  const v = value as Partial<StoredPlaylistMeta>;
  const listOk = (list: unknown): list is StoredPlaylistEntryMeta[] =>
    Array.isArray(list) &&
    list.every(
      (e) => e != null && typeof e === "object" && typeof (e as { id?: unknown }).id === "string" &&
        typeof (e as { name?: unknown }).name === "string"
    );
  return v.version === 1 && listOk(v.uploads) && listOk(v.scans);
}

/**
 * IndexedDB-backed store for user-added MIDI files.
 *
 * Pass an explicit IDBFactory to target a non-default database (used by
 * tests). When omitted, the global `indexedDB` is used; when that is
 * unavailable (e.g. Node, private-mode edge cases), every method degrades
 * to a graceful no-op default.
 */
export class MidiFileStore {
  private readonly idb: IDBFactory | null;
  private dbPromise: Promise<IDBDatabase | null> | null = null;

  constructor(idb?: IDBFactory | null) {
    if (idb !== undefined) {
      this.idb = idb;
    } else {
      this.idb = typeof indexedDB === "undefined" ? null : indexedDB;
    }
  }

  /** True when an IndexedDB factory is available to this store. */
  isSupported(): boolean {
    return this.idb != null;
  }

  private openDb(): Promise<IDBDatabase | null> {
    if (!this.dbPromise) {
      this.dbPromise = (async (): Promise<IDBDatabase | null> => {
        const idb = this.idb;
        if (!idb) return null;
        try {
          const request = idb.open(DB_NAME, DB_VERSION);
          return await new Promise<IDBDatabase | null>((resolve) => {
            request.onupgradeneeded = () => {
              try {
                const db = request.result;
                if (!db.objectStoreNames.contains(FILES_STORE)) {
                  db.createObjectStore(FILES_STORE, { keyPath: "id" });
                }
                if (!db.objectStoreNames.contains(META_STORE)) {
                  db.createObjectStore(META_STORE, { keyPath: "key" });
                }
              } catch (err) {
                warn("schema upgrade failed", err);
              }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => {
              warn("open failed", request.error);
              resolve(null);
            };
            request.onblocked = () => warn("open blocked by another tab");
          });
        } catch (err) {
          warn("open threw", err);
          return null;
        }
      })();
    }
    return this.dbPromise;
  }

  private async withStore<T>(
    storeName: string,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => Promise<T>,
    fallback: T
  ): Promise<T> {
    try {
      const db = await this.openDb();
      if (!db) return fallback;
      const tx = db.transaction(storeName, mode);
      const result = await run(tx.objectStore(storeName));
      return result;
    } catch (err) {
      warn(`"${storeName}" transaction failed`, err);
      return fallback;
    }
  }

  /** Insert or replace a MIDI file record. Resolves even on failure. */
  async putMidiFile(file: StoredMidiFile): Promise<void> {
    await this.withStore(FILES_STORE, "readwrite", (store) => requestToPromise(store.put(file)), undefined);
  }

  /** Fetch one file by id, or null when missing/unavailable. */
  async getMidiFile(id: string): Promise<StoredMidiFile | null> {
    const record = await this.withStore(
      FILES_STORE,
      "readonly",
      (store) => requestToPromise(store.get(id)),
      undefined as StoredMidiFile | undefined
    );
    if (!record || typeof record !== "object") return null;
    const r = record as Partial<StoredMidiFile>;
    if (typeof r.id !== "string" || typeof r.name !== "string" || !(r.bytes instanceof ArrayBuffer)) {
      warn(`record "${id}" failed validation`);
      return null;
    }
    return r as StoredMidiFile;
  }

  /** Fetch all stored files, or [] when unavailable. */
  async getAllMidiFiles(): Promise<StoredMidiFile[]> {
    const records = await this.withStore(
      FILES_STORE,
      "readonly",
      (store) => requestToPromise(store.getAll()),
      [] as StoredMidiFile[]
    );
    return Array.isArray(records) ? records : [];
  }

  /** Remove one file by id. Resolves even when missing or on failure. */
  async deleteMidiFile(id: string): Promise<void> {
    await this.withStore(FILES_STORE, "readwrite", (store) => requestToPromise(store.delete(id)), undefined);
  }

  /** Persist the ordered user playlist. Resolves even on failure. */
  async putPlaylistMeta(meta: StoredPlaylistMeta): Promise<void> {
    await this.withStore(
      META_STORE,
      "readwrite",
      (store) => requestToPromise(store.put({ key: PLAYLIST_META_KEY, value: meta })),
      undefined
    );
  }

  /** Fetch the ordered user playlist, or null when missing/invalid/unavailable. */
  async getPlaylistMeta(): Promise<StoredPlaylistMeta | null> {
    const record = await this.withStore(
      META_STORE,
      "readonly",
      (store) => requestToPromise(store.get(PLAYLIST_META_KEY)),
      undefined as { key: string; value: unknown } | undefined
    );
    const value = (record as { value?: unknown } | undefined)?.value;
    return isValidPlaylistMeta(value) ? value : null;
  }
}

/** App-wide singleton backed by the global IndexedDB. */
export const midiFileStore = new MidiFileStore();

/** True when the global IndexedDB is available for MIDI persistence. */
export function isMidiFileStoreSupported(): boolean {
  return midiFileStore.isSupported();
}
