// Feed impression log for personalization (docs/social/ranking.md). One row per song impression, with the
// model version that ranked it, so offline eval can compare models. Lives in shares.sqlite.
import type { DatabaseSync } from "node:sqlite";

export const ACTIONS = ["rate", "comment", "remix", "open_studio", "share"] as const;
export interface Impression { actor: string; session: string; share_id: string; dwell_ms: number; listen_ratio: number; completed: boolean; fast_skip: boolean; replay: boolean; actions: string[]; position: number; feed: string; model_version: string; client: string; ts: number }

export class EventStore {
  constructor(private db: DatabaseSync, private now: () => number = Date.now) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS impressions (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, session TEXT NOT NULL, share_id TEXT NOT NULL,
      dwell_ms INTEGER NOT NULL, listen_ratio REAL NOT NULL, completed INTEGER NOT NULL, fast_skip INTEGER NOT NULL, replay INTEGER NOT NULL, actions TEXT NOT NULL,
      position INTEGER NOT NULL, feed TEXT NOT NULL, model_version TEXT NOT NULL, client TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS impressions_actor ON impressions(actor, created_at);
      CREATE INDEX IF NOT EXISTS impressions_time ON impressions(created_at);
      CREATE INDEX IF NOT EXISTS impressions_share ON impressions(share_id);`);
  }
  insert(rows: Impression[]) {
    const st = this.db.prepare("INSERT INTO impressions (actor, session, share_id, dwell_ms, listen_ratio, completed, fast_skip, replay, actions, position, feed, model_version, client, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const t = this.now();
    for (const r of rows) st.run(r.actor, r.session, r.share_id, r.dwell_ms, r.listen_ratio, r.completed ? 1 : 0, r.fast_skip ? 1 : 0, r.replay ? 1 : 0, JSON.stringify(r.actions), r.position, r.feed, r.model_version, r.client, Math.min(t, r.ts || t));
  }
  /** Aggregate metrics over [since, now). */
  metrics(since: number) {
    const q = <T>(sql: string, ...a: (string | number)[]) => this.db.prepare(sql).get(...a) as T;
    const base = q<{ n: number; dwell: number | null; skip: number | null; comp: number | null; pos: number | null; sessions: number; actors: number }>(
      `SELECT COUNT(*) AS n, AVG(dwell_ms) AS dwell, AVG(fast_skip) AS skip, AVG(completed) AS comp, AVG(actions <> '[]') AS pos, COUNT(DISTINCT session) AS sessions, COUNT(DISTINCT actor) AS actors FROM impressions WHERE created_at >= ?`, since);
    const perSession = q<{ w: number | null }>(`SELECT AVG(w) AS w FROM (SELECT SUM(dwell_ms) AS w FROM impressions WHERE created_at >= ? GROUP BY session)`, since).w;
    // D1 retention: actors active on day d who are active again on day d+1 (days fully inside the window).
    const ret = q<{ r: number | null }>(`WITH d AS (SELECT DISTINCT actor, created_at / 86400000 AS day FROM impressions WHERE created_at >= ?)
      SELECT AVG(CASE WHEN EXISTS (SELECT 1 FROM d d2 WHERE d2.actor = d.actor AND d2.day = d.day + 1) THEN 1.0 ELSE 0 END) AS r FROM d WHERE d.day < (SELECT MAX(day) FROM d)`, since).r;
    const byModel = this.db.prepare(`SELECT model_version, COUNT(*) AS n, AVG(dwell_ms) AS dwell, AVG(fast_skip) AS skip, AVG(completed) AS comp FROM impressions WHERE created_at >= ? GROUP BY model_version ORDER BY n DESC`).all(since);
    return { impressions: base.n, sessions: base.sessions, actors: base.actors, avg_dwell_ms: Math.round(base.dwell ?? 0), skip_rate: base.skip ?? 0, completion_rate: base.comp ?? 0,
      positive_action_rate: base.pos ?? 0, avg_watch_ms_per_session: Math.round(perSession ?? 0), d1_retention: ret, by_model: byModel };
  }
  purgeActor(actor: string) { this.db.prepare("DELETE FROM impressions WHERE actor = ?").run(actor); }
  /** Retention: listening events older than 60 days are deleted (privacy policy). */
  prune(now = Date.now()) { return Number(this.db.prepare("DELETE FROM impressions WHERE created_at < ?").run(now - 60 * 86_400_000).changes); }
  countActor(actor: string) { return Number((this.db.prepare("SELECT COUNT(*) AS n FROM impressions WHERE actor = ?").get(actor) as { n: number }).n); }
}
