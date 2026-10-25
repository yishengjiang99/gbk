// Shared songs in SQLite (node:sqlite, a single file under COMPOSER_DATA_DIR; no extra service).
import { buildPreview, type PianoRollPreview } from "../../../src/agent/piano-roll-preview.ts";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ShareRow { id: string; slug: string; owner: string; title: string; project_json: string; parent_id: string | null; created_at: number; public: number; midi: Uint8Array | null; wav: Uint8Array | null; mp3: Uint8Array | null; wav_meta: string | null; project_id: string | null; updated_at: number | null; short_id?: string | null }
export interface ShareView { slug: string; title: string; owner: string; createdAt: string; public: boolean; parent: { slug: string; title: string; owner: string } | null; hasMidi: boolean; hasWav: boolean; hasMp3: boolean; wav: unknown; forks: number; updatedAt: string; projectId: string | null }

const SLUG = "abcdefghijkmnpqrstuvwxyz23456789";
const shortId = () => [...randomBytes(8)].map((b) => SLUG[b % SLUG.length]).join("");
/** Kebab-case of a song title (ASCII, max 48 chars); "" when nothing usable remains. */
export const kebabTitle = (t: string) => String(t ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
/** Canonical share slug: "<kebab-title>-<shortid>" (or just the short id for an empty title). */
export const nameSlug = (title: string, id: string) => { const k = kebabTitle(title); return k ? `${k}-${id}` : id; };
/** Short id from any slug form: a bare 8-char id or the trailing "-xxxxxxxx" of a name slug. */
export const shortIdOf = (s: string) => { const m = /(?:^|-)([a-z0-9]{8})$/.exec(String(s)); return m ? m[1] : null; };

const META_COLS = "id, slug, short_id, owner, title, project_json, parent_id, created_at, public, wav_meta, project_id, updated_at, midi IS NOT NULL AS hm, wav IS NOT NULL AS hw, mp3 IS NOT NULL AS h3";
type MetaRow = Omit<ShareRow, "midi" | "wav" | "mp3"> & { hm: number; hw: number; h3: number };
const MARK = new Uint8Array(1);
const toRow = ({ hm, hw, h3, ...r }: MetaRow): ShareRow => ({ ...r, midi: hm ? MARK : null, wav: hw ? MARK : null, mp3: h3 ? MARK : null });

export class ShareStore {
  private db: DatabaseSync;
  /** Shared connection for the social tables (same file, same transaction scope). */
  get database() { return this.db; }
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, title TEXT NOT NULL, project_json TEXT NOT NULL,
        parent_id TEXT REFERENCES shares(id) ON DELETE SET NULL, created_at INTEGER NOT NULL, public INTEGER NOT NULL DEFAULT 1, midi BLOB, wav BLOB, wav_meta TEXT);
      CREATE INDEX IF NOT EXISTS shares_public ON shares(public, created_at DESC);
      CREATE INDEX IF NOT EXISTS shares_owner ON shares(owner, created_at DESC);`);
    const cols = (this.db.prepare("PRAGMA table_info(shares)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("mp3")) this.db.exec("ALTER TABLE shares ADD COLUMN mp3 BLOB");
    if (!cols.includes("project_id")) this.db.exec("ALTER TABLE shares ADD COLUMN project_id TEXT");
    if (!cols.includes("updated_at")) this.db.exec("ALTER TABLE shares ADD COLUMN updated_at INTEGER");
    this.db.exec("CREATE INDEX IF NOT EXISTS shares_owner_project ON shares(owner, project_id)");
    // Name slugs: short_id is the stable random id (the old bare slug); slug = kebab(title)-short_id.
    if (!cols.includes("short_id")) this.db.exec("ALTER TABLE shares ADD COLUMN short_id TEXT");
    this.db.exec("UPDATE shares SET short_id = slug WHERE short_id IS NULL");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS shares_short_id ON shares(short_id)");
    for (const r of this.db.prepare("SELECT id, title, short_id, slug FROM shares").all() as { id: string; title: string; short_id: string; slug: string }[]) {
      const want = nameSlug(r.title, r.short_id); if (want !== r.slug) this.db.prepare("UPDATE shares SET slug = ? WHERE id = ?").run(want, r.id);
    }
  }
  private reslug(id: string) {
    const r = this.db.prepare("SELECT title, short_id FROM shares WHERE id = ?").get(id) as { title: string; short_id: string } | undefined;
    if (r) this.db.prepare("UPDATE shares SET slug = ? WHERE id = ?").run(nameSlug(r.title, r.short_id), id);
  }
  /** Distinct song owners (used to migrate pre-sign-in users into accounts). */
  owners(): string[] { return (this.db.prepare("SELECT DISTINCT owner FROM shares").all() as { owner: string }[]).map((r) => r.owner); }
  /** New songs are private unless the caller passes public: true (an explicit Share/Publish click). */
  create(o: { owner: string; title: string; projectJson: string; parentSlug?: string | null; public?: boolean }): ShareRow {
    const parent = o.parentSlug ? this.bySlug(o.parentSlug) : null;
    const id = `shr_${randomBytes(9).toString("hex")}`; const sid = shortId();
    this.db.prepare("INSERT INTO shares (id, slug, short_id, owner, title, project_json, parent_id, created_at, public) VALUES (?,?,?,?,?,?,?,?,?)").run(id, nameSlug(o.title, sid), sid, o.owner, o.title, o.projectJson, parent?.id ?? null, Date.now(), o.public ? 1 : 0);
    return this.bySlug(sid)!;
  }
  /** Auto-save: one PRIVATE row per (owner, local project id); later saves overwrite it (latest version only). */
  upsertAutosave(o: { owner: string; projectId: string; title: string; projectJson: string; parentSlug?: string | null }): { row: ShareRow; created: boolean } {
    const cur = this.db.prepare("SELECT slug FROM shares WHERE owner = ? AND project_id = ?").get(o.owner, o.projectId) as { slug: string } | undefined;
    if (cur) {
      this.db.prepare("UPDATE shares SET project_json = ?, updated_at = ?, title = CASE WHEN public = 1 THEN title ELSE ? END WHERE slug = ?").run(o.projectJson, Date.now(), o.title, cur.slug);
      const r = this.bySlug(cur.slug)!; this.reslug(r.id);
      return { row: this.bySlug(r.short_id ?? r.slug)!, created: false };
    }
    const parent = o.parentSlug ? this.bySlug(o.parentSlug) : null;
    const id = `shr_${randomBytes(9).toString("hex")}`; const sl = shortId(); const now = Date.now();
    this.db.prepare("INSERT INTO shares (id, slug, short_id, owner, title, project_json, parent_id, created_at, public, project_id, updated_at) VALUES (?,?,?,?,?,?,?,?,0,?,?)").run(id, nameSlug(o.title, sl), sl, o.owner, o.title, o.projectJson, parent?.id ?? null, now, o.projectId, now);
    return { row: this.bySlug(sl)!, created: true };
  }
  /** Renaming (or publishing with a title) also moves the canonical slug; the old one keeps resolving via its short id. */
  setTitle(slugv: string, title: string) { const id = this.idOf(slugv); this.db.prepare("UPDATE shares SET title = ?, updated_at = ? WHERE id = ?").run(title, Date.now(), id); this.reslug(id); }
  /** Resolve any slug form: exact canonical slug, bare short id (legacy links), or any "<words>-<shortid>" (stale names). */
  /** Metadata only: media columns come back as 1-byte presence markers, never the BLOBs (use media() for bytes). */
  bySlug(s: string): ShareRow | null {
    const v = String(s).slice(0, 128);
    const exact = this.db.prepare(`SELECT ${META_COLS} FROM shares WHERE slug = ?`).get(v) as unknown as MetaRow | undefined; if (exact) return toRow(exact);
    const sid = shortIdOf(v); if (!sid) return null;
    const r = this.db.prepare(`SELECT ${META_COLS} FROM shares WHERE short_id = ?`).get(sid) as unknown as MetaRow | undefined; return r ? toRow(r) : null;
  }
  private idOf(s: string) { return this.bySlug(s)?.id ?? "\u0000"; }
  byId(id: string): ShareRow | null { const r = this.db.prepare(`SELECT ${META_COLS} FROM shares WHERE id = ?`).get(id) as unknown as MetaRow | undefined; return r ? toRow(r) : null; }
  /** The one place media BLOBs are read: a single column for one row. */
  media(id: string, kind: "midi" | "wav" | "mp3"): Uint8Array | null {
    const r = this.db.prepare(`SELECT ${kind} AS b FROM shares WHERE id = ?`).get(id) as { b: Uint8Array | null } | undefined; return r?.b ?? null;
  }
  setMedia(slugv: string, kind: "midi" | "wav" | "mp3", bytes: Uint8Array, meta?: unknown) {
    if (kind === "mp3") this.db.prepare("UPDATE shares SET mp3 = ? WHERE id = ?").run(bytes, this.idOf(slugv));
    else if (kind === "wav") this.db.prepare("UPDATE shares SET wav = ?, wav_meta = ? WHERE id = ?").run(bytes, meta ? JSON.stringify(meta).slice(0, 4000) : null, this.idOf(slugv));
    else this.db.prepare("UPDATE shares SET midi = ? WHERE id = ?").run(bytes, this.idOf(slugv));
  }
  setPublic(slugv: string, pub: boolean) { this.db.prepare("UPDATE shares SET public = ? WHERE id = ?").run(pub ? 1 : 0, this.idOf(slugv)); }
  /** MCP project lifecycle: drop or re-own the private Studio snapshot(s) of one MCP composition. */
  deleteByProject(owner: string, projectId: string) { this.db.prepare("DELETE FROM shares WHERE owner = ? AND project_id = ?").run(owner, projectId); }
  reassignProject(fromOwner: string, toOwner: string, projectId: string) { this.db.prepare("UPDATE shares SET owner = ? WHERE owner = ? AND project_id = ?").run(toOwner, fromOwner, projectId); }
  delete(slugv: string) { this.db.prepare("DELETE FROM shares WHERE id = ?").run(this.idOf(slugv)); }
  list(o: { owner?: string; limit: number; offset: number }): ShareView[] {
    const rows = (o.owner
      ? this.db.prepare("SELECT id, slug, owner, title, parent_id, created_at, public, midi IS NOT NULL AS hm, wav IS NOT NULL AS hw, mp3 IS NOT NULL AS h3, wav_meta, project_id, updated_at FROM shares WHERE owner = ? ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ? OFFSET ?").all(o.owner, o.limit, o.offset)
      : this.db.prepare("SELECT id, slug, owner, title, parent_id, created_at, public, midi IS NOT NULL AS hm, wav IS NOT NULL AS hw, mp3 IS NOT NULL AS h3, wav_meta, project_id, updated_at FROM shares WHERE public = 1 ORDER BY created_at DESC LIMIT ? OFFSET ?").all(o.limit, o.offset)) as unknown as (ShareRow & { hm: number; hw: number; h3: number })[];
    return rows.map((r) => this.view({ ...r, midi: r.hm ? new Uint8Array(1) : null, wav: r.hw ? new Uint8Array(1) : null, mp3: r.h3 ? new Uint8Array(1) : null }));
  }
  /** Landing "top" songs: public, ranked by public fork count, then newest. (No play counter exists.) */
  top(limit: number): (ShareView & { preview: PianoRollPreview })[] {
    const rows = this.db.prepare(`SELECT s.id, s.project_json, s.updated_at, s.created_at, (SELECT COUNT(*) FROM shares c WHERE c.parent_id = s.id AND c.public = 1) AS fk
      FROM shares s WHERE s.public = 1 ORDER BY fk DESC, s.created_at DESC LIMIT ?`).all(limit) as unknown as { id: string; project_json: string; updated_at: number | null; created_at: number }[];
    return rows.map((r) => {
      const key = `${r.id}:${r.updated_at ?? r.created_at}`; let preview = this.previewCache.get(key);
      if (!preview) { try { preview = buildPreview(JSON.parse(r.project_json)); } catch { preview = buildPreview({}); } this.previewCache.set(key, preview); if (this.previewCache.size > 500) this.previewCache.delete(this.previewCache.keys().next().value!); }
      return { ...this.view(this.byId(r.id)!), preview };
    });
  }
  private previewCache = new Map<string, PianoRollPreview>();
  /** Cached piano-roll preview for one song. */
  preview(id: string): PianoRollPreview | null {
    const r = this.db.prepare("SELECT project_json, updated_at, created_at FROM shares WHERE id = ?").get(id) as { project_json: string; updated_at: number | null; created_at: number } | undefined; if (!r) return null;
    const key = `${id}:${r.updated_at ?? r.created_at}`; let p = this.previewCache.get(key);
    if (!p) { try { p = buildPreview(JSON.parse(r.project_json)); } catch { p = buildPreview({}); } this.previewCache.set(key, p); if (this.previewCache.size > 500) this.previewCache.delete(this.previewCache.keys().next().value!); }
    return p;
  }
  countRecent(owner: string, sinceMs: number) { return Number((this.db.prepare("SELECT COUNT(*) AS n FROM shares WHERE owner = ? AND created_at > ?").get(owner, Date.now() - sinceMs) as { n: number }).n); }
  view(r: ShareRow): ShareView {
    const p = r.parent_id ? this.byId(r.parent_id) : null;
    const forks = Number((this.db.prepare("SELECT COUNT(*) AS n FROM shares WHERE parent_id = ? AND public = 1").get(r.id) as { n: number }).n);
    return { slug: r.slug, title: r.title, owner: r.owner, createdAt: new Date(r.created_at).toISOString(), public: !!r.public, updatedAt: new Date(r.updated_at ?? r.created_at).toISOString(), projectId: r.project_id ?? null, parent: p ? { slug: p.slug, title: p.title, owner: p.owner } : null, hasMidi: !!r.midi, hasWav: !!r.wav, hasMp3: !!r.mp3, wav: r.wav_meta ? JSON.parse(r.wav_meta) : null, forks };
  }
}
