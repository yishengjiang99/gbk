// Browser error reports (POST /api/client-errors). Lives in accounts.sqlite as table client_errors; the only
// identity kept is the signed-in account id (no IP, no cookies, no tokens; query strings are stripped).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ClientErrorRow { id: number; created_at: number; client_ts: number | null; user_id: string | null; kind: string; message: string; stack: string; url: string; user_agent: string; release: string; count: number; context: string; breadcrumbs: string }
export type ClientErrorInput = Omit<ClientErrorRow, "id" | "created_at">;

/** Schema migrations, applied in order and recorded in client_errors_migrations. */
const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS client_errors (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, client_ts INTEGER, user_id TEXT,
     kind TEXT NOT NULL, message TEXT NOT NULL, stack TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '',
     release TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 1, context TEXT NOT NULL DEFAULT '{}', breadcrumbs TEXT NOT NULL DEFAULT '[]');
   CREATE INDEX IF NOT EXISTS client_errors_created ON client_errors(created_at DESC);
   CREATE INDEX IF NOT EXISTS client_errors_user ON client_errors(user_id, created_at DESC);`,
];

export class ClientErrorStore {
  private db: DatabaseSync;
  constructor(file: string, private maxRows = 50_000) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS client_errors_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const done = new Set((this.db.prepare("SELECT version FROM client_errors_migrations").all() as { version: number }[]).map((r) => r.version));
    MIGRATIONS.forEach((sql, i) => { if (done.has(i + 1)) return; this.db.exec(sql); this.db.prepare("INSERT INTO client_errors_migrations (version, applied_at) VALUES (?, ?)").run(i + 1, Date.now()); });
  }
  insert(rows: ClientErrorInput[], now = Date.now()) {
    const st = this.db.prepare("INSERT INTO client_errors (created_at, client_ts, user_id, kind, message, stack, url, user_agent, release, count, context, breadcrumbs) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const r of rows) st.run(now, r.client_ts, r.user_id, r.kind, r.message, r.stack, r.url, r.user_agent, r.release, r.count, r.context, r.breadcrumbs);
    if (Math.random() < 0.02 || rows.length >= 10) this.prune();
  }
  prune() { this.db.prepare("DELETE FROM client_errors WHERE id <= (SELECT id FROM client_errors ORDER BY id DESC LIMIT 1 OFFSET ?)").run(this.maxRows); }
  list(o: { limit: number; sinceMs?: number; user?: string; kind?: string; release?: string }): ClientErrorRow[] {
    const where: string[] = []; const args: (string | number)[] = [];
    if (o.sinceMs) { where.push("created_at >= ?"); args.push(o.sinceMs); }
    if (o.user) { where.push("user_id = ?"); args.push(o.user); }
    if (o.kind) { where.push("kind = ?"); args.push(o.kind); }
    if (o.release) { where.push("release = ?"); args.push(o.release); }
    return this.db.prepare(`SELECT * FROM client_errors ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`).all(...args, o.limit) as unknown as ClientErrorRow[];
  }
  count(): number { return Number((this.db.prepare("SELECT COUNT(*) AS n FROM client_errors").get() as { n: number }).n); }
  close() { this.db.close(); }
}
