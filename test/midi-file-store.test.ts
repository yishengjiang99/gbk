import test from "node:test";
import assert from "node:assert/strict";

import {
  MidiFileStore,
  isMidiFileStoreSupported,
  midiFileStore,
  type StoredMidiFile,
} from "../src/midi-file-store.ts";

// ---------------------------------------------------------------------------
// Minimal in-memory IndexedDB fake: implements just the surface the store uses
// (open + onupgradeneeded, createObjectStore w/ keyPath, transaction,
// put/get/getAll/delete). Handlers fire on a microtask so the store can attach
// onsuccess/onerror synchronously, like the real API.
// ---------------------------------------------------------------------------

type Handler = ((event: { target: unknown }) => void) | null;

class FakeRequest<T = unknown> {
  result!: T;
  error: unknown = null;
  onsuccess: Handler = null;
  onerror: Handler = null;

  _succeed(result: T): void {
    this.result = result;
    queueMicrotask(() => this.onsuccess?.({ target: this }));
  }

  _fail(error: unknown): void {
    this.error = error;
    queueMicrotask(() => this.onerror?.({ target: this }));
  }
}

class FakeObjectStore {
  private rows = new Map<unknown, Record<string, unknown>>();

  constructor(readonly keyPath: string) {}

  private keyOf(value: Record<string, unknown>): unknown {
    return value[this.keyPath];
  }

  put(value: Record<string, unknown>): FakeRequest<void> {
    const req = new FakeRequest<void>();
    queueMicrotask(() => {
      try {
        this.rows.set(this.keyOf(value), { ...value });
        req._succeed(undefined);
      } catch (err) {
        req._fail(err);
      }
    });
    return req;
  }

  get(key: unknown): FakeRequest<unknown> {
    const req = new FakeRequest<unknown>();
    queueMicrotask(() => req._succeed(this.rows.get(key)));
    return req;
  }

  getAll(): FakeRequest<unknown[]> {
    const req = new FakeRequest<unknown[]>();
    queueMicrotask(() => req._succeed([...this.rows.values()]));
    return req;
  }

  delete(key: unknown): FakeRequest<void> {
    const req = new FakeRequest<void>();
    queueMicrotask(() => {
      this.rows.delete(key);
      req._succeed(undefined);
    });
    return req;
  }
}

class FakeTransaction {
  constructor(private readonly db: FakeDatabase, private readonly names: string | string[]) {}

  objectStore(name: string): FakeObjectStore {
    const store = this.db.stores.get(name);
    if (!store) throw new Error(`no such store: ${name}`);
    return store;
  }
}

class FakeDatabase {
  readonly stores = new Map<string, FakeObjectStore>();
  readonly created: Array<{ name: string; keyPath: string }> = [];

  get objectStoreNames(): { contains: (name: string) => boolean } {
    return { contains: (name: string) => this.stores.has(name) };
  }

  createObjectStore(name: string, options: { keyPath: string }): FakeObjectStore {
    const store = new FakeObjectStore(options.keyPath);
    this.stores.set(name, store);
    this.created.push({ name, keyPath: options.keyPath });
    return store;
  }

  transaction(names: string | string[], _mode: string): FakeTransaction {
    return new FakeTransaction(this, names);
  }
}

class FakeOpenRequest extends FakeRequest<IDBDatabase> {
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
}

class FakeIDBFactory {
  private db: FakeDatabase | null = null;
  private version = 0;

  open(_name: string, version?: number): FakeOpenRequest {
    const req = new FakeOpenRequest();
    queueMicrotask(() => {
      const nextVersion = version ?? 1;
      if (!this.db || nextVersion > this.version) {
        this.db = new FakeDatabase();
        this.version = nextVersion;
        (req as { _db?: FakeDatabase })._db = this.db;
        Object.defineProperty(req, "result", { value: this.db, configurable: true });
        req.onupgradeneeded?.({ target: req });
      }
      Object.defineProperty(req, "result", { value: this.db, configurable: true });
      req._succeed(this.db as unknown as IDBDatabase);
    });
    return req;
  }

  /** Test hook: reach the underlying store to inject raw (possibly invalid) rows. */
  _rawStore(name: string): FakeObjectStore {
    const store = this.db?.stores.get(name);
    assert.ok(store, `store ${name} should exist`);
    return store;
  }
}

function asFactory(fake: FakeIDBFactory): IDBFactory {
  return fake as unknown as IDBFactory;
}

function makeFile(overrides: Partial<StoredMidiFile> = {}): StoredMidiFile {
  return {
    id: "upload-1",
    name: "song.mid",
    bytes: new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 1, 2, 3]).buffer,
    source: "upload",
    createdAt: 1700000000000,
    ...overrides,
  };
}

test("put/get round-trips binary MIDI data", async () => {
  const store = new MidiFileStore(asFactory(new FakeIDBFactory()));
  const file = makeFile();
  await store.putMidiFile(file);
  const got = await store.getMidiFile(file.id);
  assert.ok(got);
  assert.equal(got.id, file.id);
  assert.equal(got.name, file.name);
  assert.equal(got.source, file.source);
  assert.equal(got.createdAt, file.createdAt);
  assert.ok(got.bytes instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(got.bytes)], [...new Uint8Array(file.bytes)]);
});

test("getAll returns every stored file", async () => {
  const store = new MidiFileStore(asFactory(new FakeIDBFactory()));
  await store.putMidiFile(makeFile({ id: "upload-1", name: "a.mid" }));
  await store.putMidiFile(makeFile({ id: "scan-2", name: "b.mid", source: "scan" }));
  const all = await store.getAllMidiFiles();
  assert.deepEqual(
    all.map((f) => f.id).sort(),
    ["scan-2", "upload-1"]
  );
});

test("delete removes a file", async () => {
  const store = new MidiFileStore(asFactory(new FakeIDBFactory()));
  await store.putMidiFile(makeFile({ id: "upload-1" }));
  await store.deleteMidiFile("upload-1");
  assert.equal(await store.getMidiFile("upload-1"), null);
  // Deleting a missing id is a no-op, not an error.
  await store.deleteMidiFile("does-not-exist");
});

test("get returns null for an unknown id", async () => {
  const store = new MidiFileStore(asFactory(new FakeIDBFactory()));
  assert.equal(await store.getMidiFile("nope"), null);
});

test("putPlaylistMeta/getPlaylistMeta round-trips the ordered playlist", async () => {
  const store = new MidiFileStore(asFactory(new FakeIDBFactory()));
  const meta = {
    version: 1 as const,
    uploads: [
      { id: "upload-1", name: "a.mid" },
      { id: "upload-2", name: "b.mid" },
    ],
    scans: [{ id: "scan-1", name: "Scanned sheet — x" }],
  };
  await store.putPlaylistMeta(meta);
  assert.deepEqual(await store.getPlaylistMeta(), meta);
});

test("getPlaylistMeta returns null when nothing was stored", async () => {
  const store = new MidiFileStore(asFactory(new FakeIDBFactory()));
  assert.equal(await store.getPlaylistMeta(), null);
});

test("getPlaylistMeta returns null for a corrupt meta record", async () => {
  const fake = new FakeIDBFactory();
  const store = new MidiFileStore(asFactory(fake));
  await store.putMidiFile(makeFile({ id: "upload-1" })); // ensures the db + stores exist
  fake._rawStore("meta").put({ key: "playlist", value: { version: 999, uploads: "nope" } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await store.getPlaylistMeta(), null);
});

test("getMidiFile returns null for a corrupt file record", async () => {
  const fake = new FakeIDBFactory();
  const store = new MidiFileStore(asFactory(fake));
  await store.putMidiFile(makeFile({ id: "upload-1" })); // ensures the db + stores exist
  fake._rawStore("files").put({ id: "bad", name: 42, bytes: "not-a-buffer" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await store.getMidiFile("bad"), null);
});

test("schema creates files (keyPath id) and meta (keyPath key) stores", async () => {
  const fake = new FakeIDBFactory();
  const store = new MidiFileStore(asFactory(fake));
  assert.ok(store.isSupported());
  await store.putMidiFile(makeFile({ id: "upload-1" }));
  // The stores must exist and be keyed correctly for the store to have worked.
  assert.equal(fake._rawStore("files").keyPath, "id");
  assert.equal(fake._rawStore("meta").keyPath, "key");
});

test("degrades gracefully when IndexedDB is unavailable", async () => {
  const store = new MidiFileStore(null);
  assert.equal(store.isSupported(), false);
  // None of these may throw or reject.
  await store.putMidiFile(makeFile({ id: "upload-1" }));
  assert.equal(await store.getMidiFile("upload-1"), null);
  assert.deepEqual(await store.getAllMidiFiles(), []);
  await store.deleteMidiFile("upload-1");
  await store.putPlaylistMeta({ version: 1, uploads: [], scans: [] });
  assert.equal(await store.getPlaylistMeta(), null);
});

test("degrades gracefully when open throws", async () => {
  const throwing = { open(): never { throw new Error("denied"); } } as unknown as IDBFactory;
  const store = new MidiFileStore(throwing);
  await store.putMidiFile(makeFile({ id: "upload-1" }));
  assert.equal(await store.getMidiFile("upload-1"), null);
  assert.deepEqual(await store.getAllMidiFiles(), []);
  assert.equal(await store.getPlaylistMeta(), null);
});

test("singleton degrades gracefully in Node (no global indexedDB)", async () => {
  assert.equal(isMidiFileStoreSupported(), (typeof indexedDB !== "undefined"));
  assert.ok(midiFileStore instanceof MidiFileStore);
  // Must not reject even without IndexedDB.
  await midiFileStore.putMidiFile(makeFile({ id: "upload-1" }));
  assert.equal(await midiFileStore.getMidiFile("upload-1"), null);
});
