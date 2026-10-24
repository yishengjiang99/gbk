// Durable MCP store: compositions, revision snapshots, render jobs, artifacts, idempotency keys and OAuth
// records in one SQLite file (node:sqlite, same stack as shares/conversations). Artifact BYTES live on disk
// under <dataDir>/mcp-artifacts/<artifactId>.<ext>; this store keeps metadata + provenance only, so model
// context never carries binary payloads.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const newOpaqueId = (prefix: string) => `${prefix}_${randomBytes(12).toString("base64url")}`;
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export interface CompositionRow {
  id: string; owner: string; title: string; project_json: string; revision: number;
  created_at: number; updated_at: number; visibility: "private" | "public"; source: string;
}
export interface RevisionRow { composition_id: string; revision: number; project_json: string; summary: string; created_at: number }
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export interface RenderJobRow {
  id: string; composition_id: string; owner: string; revision: number; status: JobStatus; progress: number;
  config_json: string; error: string | null; created_at: number; finished_at: number | null;
}
export interface ArtifactRow {
  id: string; job_id: string | null; composition_id: string; owner: string; revision: number;
  kind: "wav" | "midi"; filename: string; mime_type: string; size_bytes: number; sha256: string;
  rel_path: string; meta_json: string; created_at: number;
}
export interface OAuthClientRow { client_id: string; client_name: string; redirect_uris: string; grant_types: string; created_at: number; cimd: number }
export interface OAuthCodeRow { code_hash: string; client_id: string; user: string; redirect_uri: string; scope: string; code_challenge: string; resource: string; expires_at: number }
export interface OAuthConsentRow { id: string; csrf_hash: string; user: string; client_id: string; redirect_uri: string; scope: string; code_challenge: string; resource: string; state: string; expires_at: number }
export interface OAuthTokenRow { token_hash: string; kind: "access" | "refresh"; client_id: string; user: string; scope: string; resource: string; expires_at: number; family: string; revoked: number }

export class McpStore {
  private db: DatabaseSync;
  readonly artifactsDir: string;
  constructor(file: string, dataDir: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.artifactsDir = join(dataDir, "mcp-artifacts");
    mkdirSync(this.artifactsDir, { recursive: true });
    this.db = new DatabaseSync(file === ":memory:" ? ":memory:" : file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS mcp_compositions (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, project_json TEXT NOT NULL,
        revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'private', source TEXT NOT NULL DEFAULT 'mcp');
      CREATE INDEX IF NOT EXISTS mcp_comp_owner ON mcp_compositions(owner, updated_at DESC);
      CREATE TABLE IF NOT EXISTS mcp_revisions (
        composition_id TEXT NOT NULL REFERENCES mcp_compositions(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, project_json TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (composition_id, revision));
      CREATE TABLE IF NOT EXISTS mcp_render_jobs (
        id TEXT PRIMARY KEY, composition_id TEXT NOT NULL, owner TEXT NOT NULL, revision INTEGER NOT NULL,
        status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0, config_json TEXT NOT NULL,
        error TEXT, created_at INTEGER NOT NULL, finished_at INTEGER);
      CREATE INDEX IF NOT EXISTS mcp_jobs_owner ON mcp_render_jobs(owner, created_at DESC);
      CREATE INDEX IF NOT EXISTS mcp_jobs_status ON mcp_render_jobs(status, created_at);
      CREATE TABLE IF NOT EXISTS mcp_artifacts (
        id TEXT PRIMARY KEY, job_id TEXT, composition_id TEXT NOT NULL, owner TEXT NOT NULL, revision INTEGER NOT NULL,
        kind TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL, rel_path TEXT NOT NULL, meta_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS mcp_art_comp ON mcp_artifacts(composition_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS mcp_idempotency (
        owner TEXT NOT NULL, key TEXT NOT NULL, tool TEXT NOT NULL, request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (owner, key));
      CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
        client_id TEXT PRIMARY KEY, client_name TEXT NOT NULL, redirect_uris TEXT NOT NULL,
        grant_types TEXT NOT NULL, created_at INTEGER NOT NULL, cimd INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
        code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, user TEXT NOT NULL, redirect_uri TEXT NOT NULL,
        scope TEXT NOT NULL, code_challenge TEXT NOT NULL, resource TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_oauth_consents (
        id TEXT PRIMARY KEY, csrf_hash TEXT NOT NULL, user TEXT NOT NULL, client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL, scope TEXT NOT NULL, code_challenge TEXT NOT NULL, resource TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT '', expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
        token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, user TEXT NOT NULL,
        scope TEXT NOT NULL, resource TEXT NOT NULL, expires_at INTEGER NOT NULL, family TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS mcp_tokens_family ON mcp_oauth_tokens(family);
    `);
    // Crash recovery: a job left "running" by a dead process can never complete; fail it explicitly so no
    // caller waits forever and no partial artifact is ever published for it (artifacts are only inserted
    // after full validation, in the same transaction as the completion update).
    this.db.prepare("UPDATE mcp_render_jobs SET status='failed', error=?, finished_at=? WHERE status='running'")
      .run(JSON.stringify({ code: "WORKER_INTERRUPTED", message: "render was interrupted by a server restart; submit a new render — retries are safe" }), Date.now());
  }
  /** Distinct composition owners (used to migrate pre-sign-in users into accounts). */
  owners(): string[] { return (this.db.prepare("SELECT DISTINCT owner FROM mcp_compositions").all() as { owner: string }[]).map((r) => r.owner); }
  close() { try { this.db.close(); } catch { /* already closed */ } }

  // ---- compositions ------------------------------------------------------------
  createComposition(o: { owner: string; title: string; projectJson: string; revision: number; source?: string }): CompositionRow {
    const now = Date.now();
    const id = newOpaqueId("cmp");
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO mcp_compositions (id, owner, title, project_json, revision, created_at, updated_at, visibility, source) VALUES (?,?,?,?,?,?,?,'private',?)")
        .run(id, o.owner, o.title, o.projectJson, o.revision, now, now, o.source ?? "mcp");
      this.db.prepare("INSERT INTO mcp_revisions (composition_id, revision, project_json, summary, created_at) VALUES (?,?,?,?,?)")
        .run(id, o.revision, o.projectJson, "created", now);
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    return this.getComposition(id, o.owner)!;
  }
  getComposition(id: string, owner: string): CompositionRow | null {
    return (this.db.prepare("SELECT * FROM mcp_compositions WHERE id = ? AND owner = ?").get(id, owner) as unknown as CompositionRow) ?? null;
  }
  getCompositionAny(id: string): CompositionRow | null {
    return (this.db.prepare("SELECT * FROM mcp_compositions WHERE id = ?").get(id) as unknown as CompositionRow) ?? null;
  }
  /**
   * Atomic compare-and-swap write: succeeds only when the stored revision still equals `expectedRevision`.
   * Returns the new row, or null on conflict (the caller turns that into STALE_REVISION).
   */
  saveRevision(o: { id: string; owner: string; title: string; projectJson: string; expectedRevision: number; newRevision: number; summary: string }): CompositionRow | null {
    const now = Date.now();
    this.db.exec("BEGIN");
    try {
      const r = this.db.prepare("UPDATE mcp_compositions SET project_json=?, title=?, revision=?, updated_at=? WHERE id=? AND owner=? AND revision=?")
        .run(o.projectJson, o.title, o.newRevision, now, o.id, o.owner, o.expectedRevision);
      if (Number(r.changes) !== 1) { this.db.exec("ROLLBACK"); return null; }
      this.db.prepare("INSERT INTO mcp_revisions (composition_id, revision, project_json, summary, created_at) VALUES (?,?,?,?,?)")
        .run(o.id, o.newRevision, o.projectJson, o.summary.slice(0, 500), now);
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    return this.getComposition(o.id, o.owner);
  }
  getRevision(id: string, owner: string, revision: number): RevisionRow | null {
    const row = this.getComposition(id, owner); if (!row) return null;
    return (this.db.prepare("SELECT * FROM mcp_revisions WHERE composition_id=? AND revision=?").get(id, revision) as unknown as RevisionRow) ?? null;
  }
  listRevisions(id: string, owner: string): { revision: number; summary: string; created_at: number }[] {
    if (!this.getComposition(id, owner)) return [];
    return this.db.prepare("SELECT revision, summary, created_at FROM mcp_revisions WHERE composition_id=? ORDER BY revision").all(id) as unknown as { revision: number; summary: string; created_at: number }[];
  }
  listCompositions(owner: string, limit: number, offset: number): CompositionRow[] {
    return this.db.prepare("SELECT * FROM mcp_compositions WHERE owner=? ORDER BY updated_at DESC LIMIT ? OFFSET ?").all(owner, limit, offset) as unknown as CompositionRow[];
  }
  countCompositions(owner: string) { return Number((this.db.prepare("SELECT COUNT(*) AS n FROM mcp_compositions WHERE owner=?").get(owner) as { n: number }).n); }
  setVisibility(id: string, owner: string, v: "private" | "public") {
    this.db.prepare("UPDATE mcp_compositions SET visibility=?, updated_at=? WHERE id=? AND owner=?").run(v, Date.now(), id, owner);
  }
  deleteComposition(id: string, owner: string): boolean {
    return Number(this.db.prepare("DELETE FROM mcp_compositions WHERE id=? AND owner=?").run(id, owner).changes) === 1;
  }

  // ---- render jobs + artifacts ---------------------------------------------------
  createJob(o: { compositionId: string; owner: string; revision: number; config: unknown }): RenderJobRow {
    const id = newOpaqueId("job");
    this.db.prepare("INSERT INTO mcp_render_jobs (id, composition_id, owner, revision, status, progress, config_json, created_at) VALUES (?,?,?,?,'queued',0,?,?)")
      .run(id, o.compositionId, o.owner, o.revision, JSON.stringify(o.config), Date.now());
    return this.getJob(id, o.owner)!;
  }
  getJob(id: string, owner: string): RenderJobRow | null {
    return (this.db.prepare("SELECT * FROM mcp_render_jobs WHERE id=? AND owner=?").get(id, owner) as unknown as RenderJobRow) ?? null;
  }
  patchJob(id: string, p: Partial<Pick<RenderJobRow, "status" | "progress" | "error" | "finished_at">>) {
    const sets: string[] = []; const vals: unknown[] = [];
    for (const [k, v] of Object.entries(p)) { sets.push(`${k}=?`); vals.push(v as never); }
    if (!sets.length) return;
    this.db.prepare(`UPDATE mcp_render_jobs SET ${sets.join(",")} WHERE id=?`).run(...vals as never[], id);
  }
  countJobsSince(owner: string, sinceMs: number) {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM mcp_render_jobs WHERE owner=? AND created_at>?").get(owner, Date.now() - sinceMs) as { n: number }).n);
  }
  queueDepth() {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM mcp_render_jobs WHERE status IN ('queued','running')").get() as { n: number }).n);
  }
  metrics() {
    const by = (s: string) => Number((this.db.prepare("SELECT COUNT(*) AS n FROM mcp_render_jobs WHERE status=?").get(s) as { n: number }).n);
    const art = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS b FROM mcp_artifacts").get() as { n: number; b: number };
    return { jobsCompleted: by("completed"), jobsFailed: by("failed"), jobsCancelled: by("cancelled"), jobsActive: this.queueDepth(),
      compositions: Number((this.db.prepare("SELECT COUNT(*) AS n FROM mcp_compositions").get() as { n: number }).n),
      artifacts: Number(art.n), artifactBytes: Number(art.b) };
  }
  addArtifact(o: Omit<ArtifactRow, "id" | "created_at">): ArtifactRow {
    const id = newOpaqueId("art");
    this.db.prepare("INSERT INTO mcp_artifacts (id, job_id, composition_id, owner, revision, kind, filename, mime_type, size_bytes, sha256, rel_path, meta_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, o.job_id, o.composition_id, o.owner, o.revision, o.kind, o.filename, o.mime_type, o.size_bytes, o.sha256, o.rel_path, o.meta_json, Date.now());
    return this.getArtifact(id, o.owner)!;
  }
  getArtifact(id: string, owner: string): ArtifactRow | null {
    return (this.db.prepare("SELECT * FROM mcp_artifacts WHERE id=? AND owner=?").get(id, owner) as unknown as ArtifactRow) ?? null;
  }
  /** Owner-free lookup for the artifact route only — the route itself enforces signature/ownership. */
  getArtifactAny(id: string): ArtifactRow | null {
    return (this.db.prepare("SELECT * FROM mcp_artifacts WHERE id=?").get(id) as unknown as ArtifactRow) ?? null;
  }
  listArtifacts(compositionId: string, owner: string): ArtifactRow[] {
    return this.db.prepare("SELECT * FROM mcp_artifacts WHERE composition_id=? AND owner=? ORDER BY created_at DESC").all(compositionId, owner) as unknown as ArtifactRow[];
  }
  latestArtifacts(compositionId: string, owner: string): { wav?: ArtifactRow; midi?: ArtifactRow } {
    const all = this.listArtifacts(compositionId, owner);
    return { wav: all.find((a) => a.kind === "wav"), midi: all.find((a) => a.kind === "midi") };
  }
  artifactAbsPath(a: ArtifactRow) { return join(this.artifactsDir, a.rel_path); }

  // ---- idempotency ---------------------------------------------------------------
  getIdempotent(owner: string, key: string): { tool: string; request_hash: string; result_json: string } | null {
    return (this.db.prepare("SELECT tool, request_hash, result_json FROM mcp_idempotency WHERE owner=? AND key=?").get(owner, key) as unknown as { tool: string; request_hash: string; result_json: string }) ?? null;
  }
  putIdempotent(owner: string, key: string, tool: string, requestHash: string, result: unknown) {
    this.db.prepare("INSERT OR REPLACE INTO mcp_idempotency (owner, key, tool, request_hash, result_json, created_at) VALUES (?,?,?,?,?,?)")
      .run(owner, key, tool, requestHash, JSON.stringify(result), Date.now());
  }

  // ---- OAuth -----------------------------------------------------------------------
  putClient(c: OAuthClientRow) {
    this.db.prepare("INSERT OR REPLACE INTO mcp_oauth_clients (client_id, client_name, redirect_uris, grant_types, created_at, cimd) VALUES (?,?,?,?,?,?)")
      .run(c.client_id, c.client_name, c.redirect_uris, c.grant_types, c.created_at, c.cimd);
  }
  getClient(clientId: string): OAuthClientRow | null {
    return (this.db.prepare("SELECT * FROM mcp_oauth_clients WHERE client_id=?").get(clientId) as unknown as OAuthClientRow) ?? null;
  }
  putCode(c: OAuthCodeRow) {
    this.db.prepare("INSERT INTO mcp_oauth_codes (code_hash, client_id, user, redirect_uri, scope, code_challenge, resource, expires_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(c.code_hash, c.client_id, c.user, c.redirect_uri, c.scope, c.code_challenge, c.resource, c.expires_at);
  }
  /** Single-use: reads and deletes the code atomically enough for this single-process server. */
  takeCode(codeHash: string): OAuthCodeRow | null {
    const row = (this.db.prepare("SELECT * FROM mcp_oauth_codes WHERE code_hash=?").get(codeHash) as unknown as OAuthCodeRow) ?? null;
    if (row) this.db.prepare("DELETE FROM mcp_oauth_codes WHERE code_hash=?").run(codeHash);
    return row;
  }
  putConsent(c: OAuthConsentRow) {
    this.db.prepare("INSERT INTO mcp_oauth_consents (id, csrf_hash, user, client_id, redirect_uri, scope, code_challenge, resource, state, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(c.id, c.csrf_hash, c.user, c.client_id, c.redirect_uri, c.scope, c.code_challenge, c.resource, c.state, c.expires_at);
  }
  /** Single-use like takeCode: ANY consent POST consumes the transaction, success or failure. */
  takeConsent(id: string): OAuthConsentRow | null {
    const row = (this.db.prepare("SELECT * FROM mcp_oauth_consents WHERE id=?").get(id) as unknown as OAuthConsentRow) ?? null;
    if (row) this.db.prepare("DELETE FROM mcp_oauth_consents WHERE id=?").run(id);
    return row;
  }
  putToken(t: Omit<OAuthTokenRow, "token_hash" | "revoked"> & { token: string }) {
    this.db.prepare("INSERT INTO mcp_oauth_tokens (token_hash, kind, client_id, user, scope, resource, expires_at, family, revoked) VALUES (?,?,?,?,?,?,?,?,0)")
      .run(hashToken(t.token), t.kind, t.client_id, t.user, t.scope, t.resource, t.expires_at, t.family);
  }
  getToken(token: string): OAuthTokenRow | null {
    return (this.db.prepare("SELECT * FROM mcp_oauth_tokens WHERE token_hash=?").get(hashToken(token)) as unknown as OAuthTokenRow) ?? null;
  }
  revokeToken(token: string) { this.db.prepare("UPDATE mcp_oauth_tokens SET revoked=1 WHERE token_hash=?").run(hashToken(token)); }
  revokeFamily(family: string) { this.db.prepare("UPDATE mcp_oauth_tokens SET revoked=1 WHERE family=?").run(family); }
}
