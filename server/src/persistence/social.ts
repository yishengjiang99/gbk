// gbk Social (P1): profiles/handles, labels/tags, ratings, comments, plays, reports, ranked feed.
// Tables live in shares.sqlite beside `shares`, created idempotently at startup. Contract: docs/social-api.md.
import type { DatabaseSync } from "node:sqlite";

export const LABELS = ["ambient", "lofi", "classical", "jazz", "rnb", "electronic", "cinematic", "game", "pop", "experimental", "wip"] as const;
export const TAG_RE = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])$/;
export const normTags = (v: unknown): string[] | null => {
  if (!Array.isArray(v)) return null;
  const out = [...new Set(v.map((t) => String(t).trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-")))];
  if (out.length > 10 || out.some((t) => !TAG_RE.test(t))) return null; return out;
};
export const normLabels = (v: unknown): string[] | null => {
  if (!Array.isArray(v)) return null; const out = [...new Set(v.map((t) => String(t).toLowerCase()))];
  if (out.length > 3 || out.some((t) => !(LABELS as readonly string[]).includes(t))) return null; return out;
};
const BAD = /\b(n[i1]gg(?:er|a)s?|f[a4]gg?[o0]ts?|k[i1]kes?|ch[i1]nks?|retards?)\b/i;
export const badText = (t: string) => BAD.test(t);

export const encCursor = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
export const decCursor = <T>(c: unknown): T | null => { if (typeof c !== "string" || !c || c.length > 300) return null; try { return JSON.parse(Buffer.from(c, "base64url").toString()) as T; } catch { return null; } };

export interface Profile { user_id: string; handle: string; display_name: string; bio: string | null; badge: string | null; dm_policy: string; handle_changed: number; created_at: number }
export interface CommentRow { id: number; share_id: string; user_id: string; body: string; created_at: number; deleted_at: number | null; hidden: number }

export class SocialStore {
  constructor(private db: DatabaseSync, private now: () => number = Date.now) {
    const cols = (this.db.prepare("PRAGMA table_info(shares)").all() as { name: string }[]).map((c) => c.name);
    const add = (c: string, d: string) => { if (!cols.includes(c)) this.db.exec(`ALTER TABLE shares ADD COLUMN ${c} ${d}`); };
    const pcols = (this.db.prepare("PRAGMA table_info(profiles)").all() as { name: string }[]).map((c) => c.name);
    if (pcols.length && !pcols.includes("badge")) this.db.exec("ALTER TABLE profiles ADD COLUMN badge TEXT");
    add("labels", "TEXT NOT NULL DEFAULT '[]'"); add("prompt_shared", "INTEGER NOT NULL DEFAULT 0"); add("prompt_text", "TEXT");
    add("rating_sum", "INTEGER NOT NULL DEFAULT 0"); add("rating_count", "INTEGER NOT NULL DEFAULT 0"); add("comment_count", "INTEGER NOT NULL DEFAULT 0");
    add("play_count", "INTEGER NOT NULL DEFAULT 0"); add("score", "REAL NOT NULL DEFAULT 0"); add("published_at", "INTEGER");
    this.db.exec(`UPDATE shares SET published_at = created_at WHERE public = 1 AND published_at IS NULL;
      CREATE INDEX IF NOT EXISTS shares_score ON shares(public, score DESC, id);
      CREATE INDEX IF NOT EXISTS shares_pub ON shares(public, published_at DESC, id);
      CREATE TABLE IF NOT EXISTS ratings (share_id TEXT NOT NULL, user_id TEXT NOT NULL, stars INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (share_id, user_id));
      CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, share_id TEXT NOT NULL, user_id TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER, hidden INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS comments_share ON comments(share_id, created_at);
      CREATE TABLE IF NOT EXISTS share_tags (share_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (share_id, tag));
      CREATE INDEX IF NOT EXISTS share_tags_tag ON share_tags(tag, share_id);
      CREATE TABLE IF NOT EXISTS profiles (user_id TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, bio TEXT, dm_policy TEXT NOT NULL DEFAULT 'all', handle_changed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, badge TEXT);
      CREATE TABLE IF NOT EXISTS blocks (blocker TEXT NOT NULL, blocked TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (blocker, blocked));
      CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, reporter TEXT NOT NULL, kind TEXT NOT NULL, target_id TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS reports_status ON reports(status, created_at);
      CREATE TABLE IF NOT EXISTS plays (share_id TEXT NOT NULL, who TEXT NOT NULL, hour INTEGER NOT NULL, PRIMARY KEY (share_id, who, hour));
      CREATE TRIGGER IF NOT EXISTS shares_social_cleanup AFTER DELETE ON shares BEGIN
        DELETE FROM ratings WHERE share_id = OLD.id; DELETE FROM comments WHERE share_id = OLD.id; DELETE FROM share_tags WHERE share_id = OLD.id; DELETE FROM plays WHERE share_id = OLD.id;
        DELETE FROM reports WHERE kind = 'song' AND (target_id = OLD.slug OR target_id = OLD.short_id); END;`);
  }

  // ---- profiles ----
  profile(userId: string): Profile | null { return (this.db.prepare("SELECT * FROM profiles WHERE user_id = ?").get(userId) as unknown as Profile) ?? null; }
  byHandle(h: string): Profile | null { return (this.db.prepare("SELECT * FROM profiles WHERE handle = ?").get(String(h).toLowerCase().slice(0, 40)) as unknown as Profile) ?? null; }
  /** Find or create; handle = slug of display name + numeric suffix when taken. */
  ensureProfile(userId: string, name: string): Profile {
    const cur = this.profile(userId); if (cur) return cur;
    const base = (String(name || userId).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "").slice(0, 16) || "user").padEnd(3, "0");
    let h = base; for (let i = 2; this.byHandle(h); i++) h = `${base}${i}`;
    this.db.prepare("INSERT INTO profiles (user_id, handle, display_name, created_at) VALUES (?,?,?,?)").run(userId, h, String(name || h).slice(0, 40), this.now());
    return this.profile(userId)!;
  }
  updateProfile(userId: string, o: { display_name?: string; handle?: string; dm_policy?: string }): "ok" | "HANDLE_TAKEN" | "HANDLE_LOCKED" {
    const p = this.profile(userId)!;
    if (o.handle !== undefined && o.handle !== p.handle) {
      if (p.handle_changed) return "HANDLE_LOCKED";
      if (this.byHandle(o.handle)) return "HANDLE_TAKEN";
      this.db.prepare("UPDATE profiles SET handle = ?, handle_changed = 1 WHERE user_id = ?").run(o.handle, userId);
    }
    if (o.display_name !== undefined) this.db.prepare("UPDATE profiles SET display_name = ? WHERE user_id = ?").run(o.display_name, userId);
    if (o.dm_policy !== undefined) this.db.prepare("UPDATE profiles SET dm_policy = ? WHERE user_id = ?").run(o.dm_policy, userId);
    return "ok";
  }
  /** AI artist provisioning (admin CLI): fixed handle, display name, bio, "AI artist" badge. */
  upsertArtist(userId: string, o: { handle: string; display_name: string; bio: string }) {
    const taken = this.byHandle(o.handle); if (taken && taken.user_id !== userId) throw new Error(`handle ${o.handle} is taken`);
    if (!this.profile(userId)) this.db.prepare("INSERT INTO profiles (user_id, handle, display_name, created_at) VALUES (?,?,?,?)").run(userId, o.handle, o.display_name, this.now());
    this.db.prepare("UPDATE profiles SET handle = ?, display_name = ?, bio = ?, badge = 'AI artist', handle_changed = 1 WHERE user_id = ?").run(o.handle, o.display_name, o.bio, userId);
    return this.profile(userId)!;
  }
  userStats(userId: string) {
    const r = this.db.prepare("SELECT COUNT(*) AS n, SUM(rating_sum) AS rs, SUM(rating_count) AS rc FROM shares WHERE owner = ? AND public = 1").get(userId) as { n: number; rs: number | null; rc: number | null };
    return { song_count: Number(r.n), rating_avg: r.rc ? Math.round((Number(r.rs) / Number(r.rc)) * 10) / 10 : null };
  }

  // ---- song meta ----
  setMeta(shareId: string, o: { labels?: string[]; tags?: string[]; prompt_shared?: boolean; prompt_text?: string | null }) {
    if (o.labels) this.db.prepare("UPDATE shares SET labels = ? WHERE id = ?").run(JSON.stringify(o.labels), shareId);
    if (o.tags) { this.db.prepare("DELETE FROM share_tags WHERE share_id = ?").run(shareId); for (const t of o.tags) this.db.prepare("INSERT INTO share_tags (share_id, tag) VALUES (?,?)").run(shareId, t); }
    if (o.prompt_shared !== undefined) this.db.prepare("UPDATE shares SET prompt_shared = ? WHERE id = ?").run(o.prompt_shared ? 1 : 0, shareId);
    if (o.prompt_text !== undefined) this.db.prepare("UPDATE shares SET prompt_text = ? WHERE id = ?").run(o.prompt_text, shareId);
  }
  markPublished(shareId: string) { this.db.prepare("UPDATE shares SET published_at = COALESCE(published_at, ?) WHERE id = ?").run(this.now(), shareId); this.rescore(shareId); }
  tagsOf(shareId: string): string[] { return (this.db.prepare("SELECT tag FROM share_tags WHERE share_id = ? ORDER BY tag").all(shareId) as { tag: string }[]).map((r) => r.tag); }
  social(shareId: string) {
    return this.db.prepare("SELECT labels, prompt_shared, prompt_text, rating_sum, rating_count, comment_count, play_count, published_at, (SELECT COUNT(*) FROM shares c WHERE c.parent_id = s.id AND c.public = 1) AS forks FROM shares s WHERE id = ?").get(shareId) as
      { labels: string; prompt_shared: number; prompt_text: string | null; rating_sum: number; rating_count: number; comment_count: number; play_count: number; published_at: number | null; forks: number };
  }
  rescore(shareId: string) {
    const r = this.social(shareId); if (!r) return;
    const age = Math.max(0, (this.now() - (r.published_at ?? this.now())) / 3_600_000);
    const avg = r.rating_count ? r.rating_sum / r.rating_count : 0;
    const score = (r.play_count * 0.2 + r.rating_count + avg * r.rating_count * 0.5 + r.comment_count * 2 + Number(r.forks) * 3 + 1) / Math.pow(age + 2, 1.5);
    this.db.prepare("UPDATE shares SET score = ? WHERE id = ?").run(score, shareId);
  }
  /** Scores decay with age; refresh public rows periodically (cheap: one UPDATE per row, bounded). */
  rescoreAll() { for (const r of this.db.prepare("SELECT id FROM shares WHERE public = 1 ORDER BY published_at DESC LIMIT 5000").all() as { id: string }[]) this.rescore(r.id); }

  // ---- feed ----
  feed(o: { sort: "for_you" | "new" | "top"; label?: string; tag?: string; owner?: string; cursor?: string | null; limit: number }): { ids: string[]; next: string | null; rows: { id: string; k: number }[]; more: boolean } {
    const where = ["s.public = 1"]; const args: (string | number)[] = [];
    if (o.label) { where.push("EXISTS (SELECT 1 FROM json_each(s.labels) WHERE value = ?)"); args.push(o.label); }
    else if (o.sort === "for_you" && !o.owner) where.push("NOT EXISTS (SELECT 1 FROM json_each(s.labels) WHERE value = 'wip')");
    if (o.tag) { where.push("EXISTS (SELECT 1 FROM share_tags t WHERE t.share_id = s.id AND t.tag = ?)"); args.push(o.tag); }
    if (o.owner) { where.push("s.owner = ?"); args.push(o.owner); }
    const key = o.sort === "new" ? "COALESCE(s.published_at, s.created_at)" : o.sort === "top" ? "(CASE WHEN s.rating_count > 0 THEN (s.rating_sum + 3.0*2) / (s.rating_count + 2) ELSE 0 END)" : "s.score";
    const c = decCursor<{ k: number; id: string }>(o.cursor);
    if (c && typeof c.k === "number" && typeof c.id === "string") { where.push(`(${key} < ? OR (${key} = ? AND s.id < ?))`); args.push(c.k, c.k, c.id); }
    const rows = this.db.prepare(`SELECT s.id, ${key} AS k FROM shares s WHERE ${where.join(" AND ")} ORDER BY k DESC, s.id DESC LIMIT ?`).all(...args, o.limit + 1) as { id: string; k: number }[];
    const more = rows.length > o.limit; const page = rows.slice(0, o.limit);
    const last = page[page.length - 1];
    return { ids: page.map((r) => r.id), next: more && last ? encCursor({ k: Number(last.k), id: last.id }) : null, rows: page.map((r) => ({ id: r.id, k: Number(r.k) })), more };
  }
  topTags(limit: number) {
    const tags = this.db.prepare("SELECT t.tag, COUNT(*) AS count FROM share_tags t JOIN shares s ON s.id = t.share_id AND s.public = 1 GROUP BY t.tag ORDER BY count DESC, t.tag LIMIT ?").all(limit) as { tag: string; count: number }[];
    const labels = this.db.prepare("SELECT j.value AS label, COUNT(*) AS count FROM shares s, json_each(s.labels) j WHERE s.public = 1 GROUP BY j.value ORDER BY count DESC").all() as { label: string; count: number }[];
    return { tags: tags.map((t) => ({ tag: t.tag, count: Number(t.count) })), labels: labels.map((l) => ({ label: l.label, count: Number(l.count) })) };
  }

  // ---- ratings ----
  myRating(shareId: string, userId: string): number | null { const r = this.db.prepare("SELECT stars FROM ratings WHERE share_id = ? AND user_id = ?").get(shareId, userId) as { stars: number } | undefined; return r ? Number(r.stars) : null; }
  rate(shareId: string, userId: string, stars: number | null) {
    const prev = this.myRating(shareId, userId);
    if (stars === null) { if (prev !== null) { this.db.prepare("DELETE FROM ratings WHERE share_id = ? AND user_id = ?").run(shareId, userId); this.db.prepare("UPDATE shares SET rating_sum = rating_sum - ?, rating_count = rating_count - 1 WHERE id = ?").run(prev, shareId); } }
    else if (prev === null) { this.db.prepare("INSERT INTO ratings VALUES (?,?,?,?)").run(shareId, userId, stars, this.now()); this.db.prepare("UPDATE shares SET rating_sum = rating_sum + ?, rating_count = rating_count + 1 WHERE id = ?").run(stars, shareId); }
    else { this.db.prepare("UPDATE ratings SET stars = ?, updated_at = ? WHERE share_id = ? AND user_id = ?").run(stars, this.now(), shareId, userId); this.db.prepare("UPDATE shares SET rating_sum = rating_sum + ? WHERE id = ?").run(stars - prev, shareId); }
    this.rescore(shareId);
  }

  // ---- comments ----
  addComment(shareId: string, userId: string, body: string): CommentRow {
    const r = this.db.prepare("INSERT INTO comments (share_id, user_id, body, created_at) VALUES (?,?,?,?)").run(shareId, userId, body, this.now());
    this.db.prepare("UPDATE shares SET comment_count = comment_count + 1 WHERE id = ?").run(shareId); this.rescore(shareId);
    return this.comment(Number(r.lastInsertRowid))!;
  }
  comment(id: number): CommentRow | null { return (this.db.prepare("SELECT * FROM comments WHERE id = ?").get(id) as unknown as CommentRow) ?? null; }
  comments(shareId: string, o: { order: "new" | "old"; cursor?: string | null; limit: number; viewer?: string | null }): { rows: CommentRow[]; next: string | null } {
    const c = decCursor<{ id: number }>(o.cursor); const asc = o.order === "old";
    const args: (string | number)[] = [shareId]; let w = "share_id = ? AND deleted_at IS NULL AND hidden = 0";
    if (c && typeof c.id === "number") { w += asc ? " AND id > ?" : " AND id < ?"; args.push(c.id); }
    if (o.viewer) { w += " AND user_id NOT IN (SELECT blocked FROM blocks WHERE blocker = ?)"; args.push(o.viewer); }
    const rows = this.db.prepare(`SELECT * FROM comments WHERE ${w} ORDER BY id ${asc ? "ASC" : "DESC"} LIMIT ?`).all(...args, o.limit + 1) as unknown as CommentRow[];
    const more = rows.length > o.limit; const page = rows.slice(0, o.limit);
    return { rows: page, next: more ? encCursor({ id: Number(page[page.length - 1].id) }) : null };
  }
  removeComment(id: number, field: "deleted_at" | "hidden") {
    const c = this.comment(id); if (!c || c.deleted_at || c.hidden) return;
    this.db.prepare(`UPDATE comments SET ${field} = ? WHERE id = ?`).run(field === "hidden" ? 1 : this.now(), id);
    this.db.prepare("UPDATE shares SET comment_count = MAX(0, comment_count - 1) WHERE id = ?").run(c.share_id); this.rescore(c.share_id);
  }
  countComments(userId: string, sinceMs: number) { return Number((this.db.prepare("SELECT COUNT(*) AS n FROM comments WHERE user_id = ? AND created_at > ?").get(userId, this.now() - sinceMs) as { n: number }).n); }

  // ---- plays ----
  play(shareId: string, who: string): boolean {
    const r = this.db.prepare("INSERT OR IGNORE INTO plays VALUES (?,?,?)").run(shareId, who, Math.floor(this.now() / 3_600_000));
    if (!Number(r.changes)) return false;
    this.db.prepare("UPDATE shares SET play_count = play_count + 1 WHERE id = ?").run(shareId); this.rescore(shareId); return true;
  }

  // ---- blocks / reports ----
  blocked(blocker: string, blocked: string) { return !!this.db.prepare("SELECT 1 FROM blocks WHERE blocker = ? AND blocked = ?").get(blocker, blocked); }
  report(o: { reporter: string; kind: string; target: string; reason: string }): number {
    const r = this.db.prepare("INSERT INTO reports (reporter, kind, target_id, reason, created_at) VALUES (?,?,?,?,?)").run(o.reporter, o.kind, o.target, o.reason, this.now());
    if (o.kind === "comment") {
      const n = Number((this.db.prepare("SELECT COUNT(DISTINCT reporter) AS n FROM reports WHERE kind = 'comment' AND target_id = ? AND status = 'open'").get(o.target) as { n: number }).n);
      if (n >= 3) this.removeComment(Number(o.target), "hidden");
    }
    return Number(r.lastInsertRowid);
  }
  reports(o: { status: string; cursor?: string | null; limit: number }) {
    const c = decCursor<{ id: number }>(o.cursor); const args: (string | number)[] = [o.status];
    const rows = this.db.prepare(`SELECT * FROM reports WHERE status = ? ${c ? "AND id < ?" : ""} ORDER BY id DESC LIMIT ?`).all(...args, ...(c ? [c.id] : []), o.limit + 1) as { id: number; reporter: string; kind: string; target_id: string; reason: string; status: string; created_at: number }[];
    const more = rows.length > o.limit; const page = rows.slice(0, o.limit);
    return { rows: page, next: more ? encCursor({ id: Number(page[page.length - 1].id) }) : null };
  }
  /** Guest sign-up: create a profile with exactly this handle; false when taken. */
  createProfileExact(userId: string, handle: string, displayName: string): boolean {
    if (this.byHandle(handle)) return false;
    try { this.db.prepare("INSERT INTO profiles (user_id, handle, display_name, created_at) VALUES (?,?,?,?)").run(userId, handle, displayName, this.now()); return true; } catch { return false; }
  }
  /** Guest -> existing account merge: ratings move unless already rated; comments, reports, blocks re-owned; guest profile dropped. */
  mergeUser(from: string, to: string) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE OR IGNORE ratings SET user_id = ? WHERE user_id = ?").run(to, from);
      for (const r of this.db.prepare("SELECT share_id FROM ratings WHERE user_id = ?").all(from) as { share_id: string }[]) this.rate(r.share_id, from, null);
      this.db.prepare("UPDATE comments SET user_id = ? WHERE user_id = ?").run(to, from);
      this.db.prepare("UPDATE reports SET reporter = ? WHERE reporter = ?").run(to, from);
      this.db.prepare("UPDATE OR IGNORE blocks SET blocker = ? WHERE blocker = ?").run(to, from); this.db.prepare("DELETE FROM blocks WHERE blocker = ? OR blocker = blocked").run(from);
      try { this.db.prepare("UPDATE impressions SET actor = ? WHERE actor = ?").run(to, from); } catch { /* no table yet */ }
      this.db.prepare("DELETE FROM profiles WHERE user_id = ?").run(from);
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  reportById(id: number) { return this.db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as { id: number; kind: string; target_id: string; status: string } | undefined; }
  resolveReport(id: number, status: "hidden" | "dismissed") { const r = this.reportById(id); if (r) this.db.prepare("UPDATE reports SET status = ? WHERE kind = ? AND target_id = ? AND status = 'open'").run(status, r.kind, r.target_id); }
  /** Test cleanup / account deletion: drop a user's social rows. */
  purgeUser(userId: string) {
    for (const c of this.db.prepare("SELECT id FROM comments WHERE user_id = ? AND deleted_at IS NULL").all(userId) as { id: number }[]) this.removeComment(Number(c.id), "deleted_at");
    for (const r of this.db.prepare("SELECT share_id FROM ratings WHERE user_id = ?").all(userId) as { share_id: string }[]) this.rate(r.share_id, userId, null);
    this.db.prepare("DELETE FROM reports WHERE reporter = ?").run(userId); try { this.db.prepare("DELETE FROM impressions WHERE actor = ?").run(userId); } catch { /* table not created yet */ } this.db.prepare("DELETE FROM profiles WHERE user_id = ?").run(userId);
  }
}
