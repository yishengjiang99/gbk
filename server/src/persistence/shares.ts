// Shared songs in SQLite (node:sqlite, a single file under COMPOSER_DATA_DIR; no extra service).
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ShareRow { id: string; slug: string; owner: string; title: string; project_json: string; parent_id: string | null; created_at: number; public: number; midi: Uint8Array | null; wav: Uint8Array | null; wav_meta: string | null }
export interface ShareView { slug: string; title: string; owner: string; createdAt: string; public: boolean; parent: { slug: string; title: string; owner: string } | null; hasMidi: boolean; hasWav: boolean; wav: unknown; forks: number }

const SLUG = "abcdefghijkmnpqrstuvwxyz23456789";
const slug = () => [...randomBytes(8)].map((b) => SLUG[b % SLUG.length]).join("");

export class ShareStore {
  private db: DatabaseSync;
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, title TEXT NOT NULL, project_json TEXT NOT NULL,
        parent_id TEXT REFERENCES shares(id) ON DELETE SET NULL, created_at INTEGER NOT NULL, public INTEGER NOT NULL DEFAULT 1, midi BLOB, wav BLOB, wav_meta TEXT);
      CREATE INDEX IF NOT EXISTS shares_public ON shares(public, created_at DESC);
      CREATE INDEX IF NOT EXISTS shares_owner ON shares(owner, created_at DESC);`);
  }
  create(o: { owner: string; title: string; projectJson: string; parentSlug?: string | null }): ShareRow {
    const parent = o.parentSlug ? this.bySlug(o.parentSlug) : null;
    const id = `shr_${randomBytes(9).toString("hex")}`; const s = slug();
    this.db.prepare("INSERT INTO shares (id, slug, owner, title, project_json, parent_id, created_at, public) VALUES (?,?,?,?,?,?,?,1)").run(id, s, o.owner, o.title, o.projectJson, parent?.id ?? null, Date.now());
    return this.bySlug(s)!;
  }
  bySlug(s: string): ShareRow | null { return (this.db.prepare("SELECT * FROM shares WHERE slug = ?").get(String(s).slice(0, 32)) as unknown as ShareRow) ?? null; }
  byId(id: string): ShareRow | null { return (this.db.prepare("SELECT * FROM shares WHERE id = ?").get(id) as unknown as ShareRow) ?? null; }
  setMedia(slugv: string, kind: "midi" | "wav", bytes: Uint8Array, meta?: unknown) {
    if (kind === "wav") this.db.prepare("UPDATE shares SET wav = ?, wav_meta = ? WHERE slug = ?").run(bytes, meta ? JSON.stringify(meta).slice(0, 4000) : null, slugv);
    else this.db.prepare("UPDATE shares SET midi = ? WHERE slug = ?").run(bytes, slugv);
  }
  setPublic(slugv: string, pub: boolean) { this.db.prepare("UPDATE shares SET public = ? WHERE slug = ?").run(pub ? 1 : 0, slugv); }
  delete(slugv: string) { this.db.prepare("DELETE FROM shares WHERE slug = ?").run(slugv); }
  list(o: { owner?: string; limit: number; offset: number }): ShareView[] {
    const rows = (o.owner
      ? this.db.prepare("SELECT id, slug, owner, title, parent_id, created_at, public, midi IS NOT NULL AS hm, wav IS NOT NULL AS hw, wav_meta FROM shares WHERE owner = ? ORDER BY created_at DESC LIMIT ? OFFSET ?").all(o.owner, o.limit, o.offset)
      : this.db.prepare("SELECT id, slug, owner, title, parent_id, created_at, public, midi IS NOT NULL AS hm, wav IS NOT NULL AS hw, wav_meta FROM shares WHERE public = 1 ORDER BY created_at DESC LIMIT ? OFFSET ?").all(o.limit, o.offset)) as unknown as (ShareRow & { hm: number; hw: number })[];
    return rows.map((r) => this.view({ ...r, midi: r.hm ? new Uint8Array(1) : null, wav: r.hw ? new Uint8Array(1) : null }));
  }
  countRecent(owner: string, sinceMs: number) { return Number((this.db.prepare("SELECT COUNT(*) AS n FROM shares WHERE owner = ? AND created_at > ?").get(owner, Date.now() - sinceMs) as { n: number }).n); }
  view(r: ShareRow): ShareView {
    const p = r.parent_id ? this.byId(r.parent_id) : null;
    const forks = Number((this.db.prepare("SELECT COUNT(*) AS n FROM shares WHERE parent_id = ? AND public = 1").get(r.id) as { n: number }).n);
    return { slug: r.slug, title: r.title, owner: r.owner, createdAt: new Date(r.created_at).toISOString(), public: !!r.public, parent: p ? { slug: p.slug, title: p.title, owner: p.owner } : null, hasMidi: !!r.midi, hasWav: !!r.wav, wav: r.wav_meta ? JSON.parse(r.wav_meta) : null, forks };
  }
}
