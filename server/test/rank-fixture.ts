// Synthetic ranking fixtures: a shares DB with songs + impressions written directly (no HTTP), for ranker unit tests.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShareStore } from "../src/persistence/shares.ts";
import { SocialStore } from "../src/persistence/social.ts";
import { EventStore } from "../src/persistence/events.ts";

export const H = 3_600_000, D = 86_400_000;
export function fixture(o: { file?: boolean; now?: number } = {}) {
  let t = o.now ?? Date.UTC(2026, 9, 25, 12); const now = () => t;
  const file = o.file ? join(mkdtempSync(join(tmpdir(), "rank-")), "shares.sqlite") : ":memory:";
  const shares = new ShareStore(file); const db = shares.database; const social = new SocialStore(db, now); const events = new EventStore(db, now);
  const song = (s: { owner: string; title?: string; labels?: string[]; tags?: string[]; ageH?: number; score?: number; parent?: string | null; seconds?: number; program?: number }) => {
    const sec = s.seconds ?? 60; const ppq = 480; const ticks = Math.round((sec * 2) * ppq); // 120 bpm
    const pj = JSON.stringify({ name: s.title ?? "x", ppq, tempos: [{ tick: 0, microPerQuarter: 500000 }], tracks: [{ id: "t1", program: s.program ?? 0, channel: 0 }], notes: [{ id: "n1", trackId: "t1", channel: 0, pitch: 60, tick: 0, duration: ticks, velocity: 90 }] });
    const r = shares.create({ owner: s.owner, title: s.title ?? `Song ${Math.random().toString(36).slice(2, 7)}`, projectJson: pj, public: true });
    db.prepare("UPDATE shares SET labels = ?, score = ?, published_at = ?, parent_id = ? WHERE id = ?").run(JSON.stringify(s.labels ?? []), s.score ?? 0, t - (s.ageH ?? 24 * 10) * H, s.parent ?? null, r.id);
    for (const tag of s.tags ?? []) db.prepare("INSERT INTO share_tags (share_id, tag) VALUES (?,?)").run(r.id, tag);
    return r.id;
  };
  const imp = (i: { actor: string; session?: string; song: string; at: number; good?: boolean; skip?: boolean; dwell?: number; ratio?: number; completed?: boolean; replay?: boolean; actions?: string[] }) => {
    const good = i.good ?? false; const skip = i.skip ?? !good;
    db.prepare("INSERT INTO impressions (actor, session, share_id, dwell_ms, listen_ratio, completed, fast_skip, replay, actions, position, feed, model_version, client, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(i.actor, i.session ?? `s-${i.actor}-${Math.floor(i.at / D)}`, i.song, i.dwell ?? (skip ? 800 : good ? 40000 : 5000), i.ratio ?? (good ? 1 : 0.05), (i.completed ?? good) ? 1 : 0, skip ? 1 : 0, i.replay ? 1 : 0, JSON.stringify(i.actions ?? []), 0, "for_you", "heur-2", "web", i.at);
  };
  return { db, file, shares, social, events, song, imp, now, set: (v: number) => { t = v; } };
}
export const rand = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
