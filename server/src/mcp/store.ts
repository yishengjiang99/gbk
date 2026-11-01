// Durable MCP store: compositions, revision snapshots, render jobs, artifacts, idempotency keys and OAuth
// records in one SQLite file (node:sqlite, same stack as shares/conversations). Artifact BYTES live on disk
// under <dataDir>/mcp-artifacts/<artifactId>.<ext>; this store keeps metadata + provenance only, so model
// context never carries binary payloads.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
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
export interface OAuthTokenRow { token_hash: string; kind: "access" | "refresh"; client_id: string; user: string; scope: string; resource: string; expires_at: number; family: string; revoked: number; daily_render_limit?: number | null }

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
      CREATE TABLE IF NOT EXISTS mcp_guest_usage (bucket TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS mcp_guest_usage_time ON mcp_guest_usage(bucket, at);
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
    McpStore.migrate(this.db);
    // Crash recovery: a job left "running" by a dead process can never complete; fail it explicitly so no
    // caller waits forever and no partial artifact is ever published for it (artifacts are only inserted
    // after full validation, in the same transaction as the completion update).
    this.db.prepare("UPDATE mcp_render_jobs SET status='failed', error=?, finished_at=? WHERE status='running'")
      .run(JSON.stringify({ code: "WORKER_INTERRUPTED", message: "render was interrupted by a server restart; submit a new render — retries are safe" }), Date.now());
  }
  /** Idempotent additive migrations (safe to run on every start). daily_render_limit lives on every token row of a
   *  family (access + refresh rotate within one family); NULL means "use the global/per-account cap". */
  static migrate(db: DatabaseSync) {
    const cols = (t: string) => new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name));
    if (!cols("mcp_oauth_tokens").has("daily_render_limit")) db.exec("ALTER TABLE mcp_oauth_tokens ADD COLUMN daily_render_limit INTEGER");
    if (!cols("mcp_render_jobs").has("token_family")) db.exec("ALTER TABLE mcp_render_jobs ADD COLUMN token_family TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS mcp_jobs_family ON mcp_render_jobs(token_family, created_at)");
  }
  /** Distinct composition owners (used to migrate pre-sign-in users into accounts). */
  owners(): string[] { return (this.db.prepare("SELECT DISTINCT owner FROM mcp_compositions").all() as { owner: string }[]).map((r) => r.owner); }
  close() { try { this.db.close(); } catch { /* already closed */ } }

  // ---- guest admission (durable across sessions, IPs and restarts) ---------------------------
  /** Take one unit from a global rolling-24h guest budget; false when exhausted. */
  takeGuestBudget(bucket: string, limit: number): boolean {
    const cutoff = Date.now() - 86_400_000;
    this.db.prepare("DELETE FROM mcp_guest_usage WHERE at <= ?").run(cutoff);
    this.db.prepare("DELETE FROM mcp_idempotency WHERE owner LIKE 'guest:%' AND created_at <= ?").run(cutoff);
    const r = this.db.prepare("INSERT INTO mcp_guest_usage (bucket, at) SELECT ?, ? WHERE (SELECT COUNT(*) FROM mcp_guest_usage WHERE bucket=?) < ?").run(bucket, Date.now(), bucket, limit);
    return Number(r.changes) === 1;
  }
  /** Bytes held by guest project data: latest copies (x2 for the Studio snapshot), revisions and retry results.
   *  With `owner`: that one guest project, plus its render artifacts. Without: all guests, artifacts excluded
   *  (artifacts are bounded per project and by guest artifact retention, so they cannot fill the shared budget). */
  guestStorageBytes(owner?: string): number {
    const o = owner ?? "guest:%", op = owner ? "=" : "LIKE";
    const row = this.db.prepare(`SELECT
      (SELECT COALESCE(SUM(2 * length(CAST(project_json AS BLOB))),0) FROM mcp_compositions WHERE owner ${op} ?) +
      (SELECT COALESCE(SUM(length(CAST(project_json AS BLOB))),0) FROM mcp_revisions WHERE composition_id IN (SELECT id FROM mcp_compositions WHERE owner ${op} ?)) +
      (SELECT COALESCE(SUM(length(CAST(result_json AS BLOB))),0) FROM mcp_idempotency WHERE owner ${op} ?)
      ${owner ? "+ (SELECT COALESCE(SUM(size_bytes),0) FROM mcp_artifacts WHERE owner = ?)" : ""} AS n`).get(...(owner ? [o, o, o, o] : [o, o, o])) as { n: number };
    return Number(row.n);
  }
  /** Expire guest projects untouched (no edit, render or artifact) for `days` that were never made public. Never touches
   *  signed-in owners or public compositions; published Feed shares live in shares.sqlite and are not affected. */
  pruneGuestCompositions(days: number): { count: number; bytes: number } {
    const cutoff = Date.now() - days * 86_400_000;
    const rows = this.db.prepare(`SELECT id, owner FROM mcp_compositions c WHERE owner LIKE 'guest:%' AND visibility != 'public' AND updated_at <= ?
      AND NOT EXISTS (SELECT 1 FROM mcp_render_jobs j WHERE j.composition_id = c.id AND j.created_at > ?)
      AND NOT EXISTS (SELECT 1 FROM mcp_artifacts a WHERE a.composition_id = c.id AND a.created_at > ?)`).all(cutoff, cutoff, cutoff) as { id: string; owner: string }[];
    let bytes = 0, count = 0;
    for (const r of rows) { if (!r.owner.startsWith("guest:")) continue; const b = this.guestStorageBytes(r.owner); if (this.deleteComposition(r.id, r.owner)) { count++; bytes += b; } }
    return { count, bytes };
  }
  /** Guest render artifacts expire sooner than account ones. Returns { count, bytes } removed. */
  pruneGuestArtifacts(days: number): { count: number; bytes: number } {
    const rows = this.db.prepare("SELECT * FROM mcp_artifacts WHERE owner LIKE 'guest:%' AND created_at <= ?").all(Date.now() - days * 86_400_000) as unknown as ArtifactRow[];
    let bytes = 0; for (const row of rows) { rmSync(this.artifactAbsPath(row), { force: true }); this.db.prepare("DELETE FROM mcp_artifacts WHERE id=?").run(row.id); bytes += row.size_bytes; }
    return { count: rows.length, bytes };
  }
  guestCompositionCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM mcp_compositions WHERE owner LIKE 'guest:%'").get() as { n: number }).n);
  }
  /** Permanently delete one composition with its revisions, jobs, artifacts (rows + bytes) and retry records. */
  deleteComposition(id: string, owner: string): boolean {
    const arts = this.db.prepare("SELECT * FROM mcp_artifacts WHERE composition_id=? AND owner=?").all(id, owner) as unknown as ArtifactRow[];
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM mcp_artifacts WHERE composition_id=? AND owner=?").run(id, owner);
      this.db.prepare("DELETE FROM mcp_render_jobs WHERE composition_id=? AND owner=?").run(id, owner);
      this.db.prepare("DELETE FROM mcp_revisions WHERE composition_id=? AND composition_id IN (SELECT id FROM mcp_compositions WHERE owner=?)").run(id, owner);
      const n = Number(this.db.prepare("DELETE FROM mcp_compositions WHERE id=? AND owner=?").run(id, owner).changes);
      if (owner.startsWith("guest:")) this.db.prepare("DELETE FROM mcp_idempotency WHERE owner=?").run(owner);
      this.db.exec("COMMIT");
      for (const a of arts) rmSync(this.artifactAbsPath(a), { force: true });
      return n === 1;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  /** Move one composition (and its jobs/artifacts) to a new owner: guest project -> account (claim). */
  reassignComposition(id: string, fromOwner: string, toOwner: string): boolean {
    this.db.exec("BEGIN");
    try {
      const n = Number(this.db.prepare("UPDATE mcp_compositions SET owner=?, updated_at=? WHERE id=? AND owner=?").run(toOwner, Date.now(), id, fromOwner).changes);
      if (n === 1) {
        this.db.prepare("UPDATE mcp_render_jobs SET owner=? WHERE composition_id=? AND owner=?").run(toOwner, id, fromOwner);
        this.db.prepare("UPDATE mcp_artifacts SET owner=? WHERE composition_id=? AND owner=?").run(toOwner, id, fromOwner);
        this.db.prepare("DELETE FROM mcp_idempotency WHERE owner=?").run(fromOwner);
      }
      this.db.exec("COMMIT");
      return n === 1;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  /** Delete artifact bytes + rows older than the retention window. Returns how many were removed.
   * Tier rule (#132): artifacts whose owner is Pro are kept for proRetentionDays instead. */
  pruneArtifacts(retentionDays: number, proRetentionDays?: number, isProOwner?: (owner: string) => boolean): number {
    const rows = this.db.prepare("SELECT * FROM mcp_artifacts WHERE created_at <= ?").all(Date.now() - retentionDays * 86_400_000) as unknown as ArtifactRow[];
    let removed = 0;
    for (const row of rows) {
      if (proRetentionDays !== undefined && isProOwner?.(row.owner) && row.created_at > Date.now() - proRetentionDays * 86_400_000) continue;
      rmSync(this.artifactAbsPath(row), { force: true }); this.db.prepare("DELETE FROM mcp_artifacts WHERE id=?").run(row.id); removed++;
    }
    return removed;
  }

  /** Keep only the newest `keep` revision snapshots of a composition (#132 tier history limit). */
  pruneRevisions(compositionId: string, keep: number): number {
    const r = this.db.prepare("DELETE FROM mcp_revisions WHERE composition_id=? AND revision NOT IN (SELECT revision FROM mcp_revisions WHERE composition_id=? ORDER BY revision DESC LIMIT ?)").run(compositionId, compositionId, keep);
    return Number(r.changes);
  }

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

  // ---- render jobs + artifacts ---------------------------------------------------
  createJob(o: { compositionId: string; owner: string; revision: number; config: unknown; tokenFamily?: string }): RenderJobRow {
    const id = newOpaqueId("job");
    this.db.prepare("INSERT INTO mcp_render_jobs (id, composition_id, owner, revision, status, progress, config_json, created_at, token_family) VALUES (?,?,?,?,'queued',0,?,?,?)")
      .run(id, o.compositionId, o.owner, o.revision, JSON.stringify(o.config), Date.now(), o.tokenFamily ?? null);
    return this.getJob(id, o.owner)!;
  }
  getJob(id: string, owner: string): RenderJobRow | null {
    return (this.db.prepare("SELECT * FROM mcp_render_jobs WHERE id=? AND owner=?").get(id, owner) as unknown as RenderJobRow) ?? null;
  }
  /** Owner-free lookup for the render service only — callers enforce ownership before exposing data. */
  getJobAny(id: string): RenderJobRow | null {
    return (this.db.prepare("SELECT * FROM mcp_render_jobs WHERE id=?").get(id) as unknown as RenderJobRow) ?? null;
  }
  listJobsByStatus(status: JobStatus): RenderJobRow[] {
    return this.db.prepare("SELECT * FROM mcp_render_jobs WHERE status=? ORDER BY created_at ASC").all(status) as unknown as RenderJobRow[];
  }
  patchJob(id: string, p: Partial<Pick<RenderJobRow, "status" | "progress" | "error" | "finished_at">>) {
    const sets: string[] = []; const vals: unknown[] = [];
    for (const [k, v] of Object.entries(p)) { sets.push(`${k}=?`); vals.push(v as never); }
    if (!sets.length) return;
    this.db.prepare(`UPDATE mcp_render_jobs SET ${sets.join(",")} WHERE id=?`).run(...vals as never[], id);
  }
  /**
   * Guarded job transition: applies the patch only while the job is in one of `from`. Returns false
   * (and changes nothing) when the job already left those states — this is what makes terminal states
   * (completed/failed/cancelled) final against racing worker exits, timeouts and cancels.
   */
  transitionJob(id: string, from: JobStatus[], p: Partial<Pick<RenderJobRow, "status" | "progress" | "error" | "finished_at">>): boolean {
    const sets: string[] = []; const vals: unknown[] = [];
    for (const [k, v] of Object.entries(p)) { sets.push(`${k}=?`); vals.push(v as never); }
    if (!sets.length || !from.length) return false;
    const ph = from.map(() => "?").join(",");
    return Number(this.db.prepare(`UPDATE mcp_render_jobs SET ${sets.join(",")} WHERE id=? AND status IN (${ph})`).run(...vals as never[], id, ...(from as never[])).changes) === 1;
  }
  countJobsSince(owner: string, sinceMs: number) {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM mcp_render_jobs WHERE owner=? AND created_at>?").get(owner, Date.now() - sinceMs) as { n: number }).n);
  }
  /** Renders started by any token of an OAuth family in the window. */
  countFamilyJobsSince(family: string, sinceMs: number) {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM mcp_render_jobs WHERE token_family=? AND created_at>?").get(family, Date.now() - sinceMs) as { n: number }).n);
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
  private insertArtifact(o: Omit<ArtifactRow, "id" | "created_at">): string {
    const id = newOpaqueId("art");
    this.db.prepare("INSERT INTO mcp_artifacts (id, job_id, composition_id, owner, revision, kind, filename, mime_type, size_bytes, sha256, rel_path, meta_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, o.job_id, o.composition_id, o.owner, o.revision, o.kind, o.filename, o.mime_type, o.size_bytes, o.sha256, o.rel_path, o.meta_json, Date.now());
    return id;
  }
  addArtifact(o: Omit<ArtifactRow, "id" | "created_at">): ArtifactRow {
    return this.getArtifact(this.insertArtifact(o), o.owner)!;
  }
  /** Atomic multi-insert for render publication: either every artifact row lands or none does. */
  addArtifacts(list: Omit<ArtifactRow, "id" | "created_at">[]): ArtifactRow[] {
    this.db.exec("BEGIN");
    try {
      const ids = list.map((o) => this.insertArtifact(o));
      this.db.exec("COMMIT");
      return ids.map((id, i) => this.getArtifact(id, list[i].owner)!);
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
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
    // New tokens (refresh rotation) inherit the family's custom render limit.
    this.db.prepare("INSERT INTO mcp_oauth_tokens (token_hash, kind, client_id, user, scope, resource, expires_at, family, revoked, daily_render_limit) VALUES (?,?,?,?,?,?,?,?,0,(SELECT MAX(daily_render_limit) FROM mcp_oauth_tokens WHERE family=?))")
      .run(hashToken(t.token), t.kind, t.client_id, t.user, t.scope, t.resource, t.expires_at, t.family, t.family);
  }
  getToken(token: string): OAuthTokenRow | null {
    return (this.db.prepare("SELECT * FROM mcp_oauth_tokens WHERE token_hash=?").get(hashToken(token)) as unknown as OAuthTokenRow) ?? null;
  }
  revokeToken(token: string) { this.db.prepare("UPDATE mcp_oauth_tokens SET revoked=1 WHERE token_hash=?").run(hashToken(token)); }
  /** Custom daily render limit for a token family, or null (use the global cap). */
  familyRenderLimit(family: string): number | null {
    const r = this.db.prepare("SELECT MAX(daily_render_limit) AS n FROM mcp_oauth_tokens WHERE family=?").get(family) as { n: number | null } | undefined;
    return r?.n == null ? null : Number(r.n);
  }
  /** Admin: set (or clear with null) the daily render limit on every token of each family starting with `prefix`. */
  setFamilyRenderLimit(prefix: string, limit: number | null) { return setFamilyRenderLimit(this.db, prefix, limit); }
  revokeFamily(family: string) { this.db.prepare("UPDATE mcp_oauth_tokens SET revoked=1 WHERE family=?").run(family); }
}

/** Set (or clear with null) daily_render_limit on every token row whose family starts with `prefix` (LIKE-escaped).
 *  Standalone so the admin CLI can run it against the live DB without McpStore's startup crash recovery. */
export function setFamilyRenderLimit(db: DatabaseSync, prefix: string, limit: number | null): { families: string[]; tokens: number } {
  const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const families = (db.prepare("SELECT DISTINCT family FROM mcp_oauth_tokens WHERE family LIKE ? ESCAPE '\\'").all(like) as { family: string }[]).map((r) => r.family);
  const r = db.prepare("UPDATE mcp_oauth_tokens SET daily_render_limit=? WHERE family LIKE ? ESCAPE '\\'").run(limit, like);
  return { families, tokens: Number(r.changes) };
}
