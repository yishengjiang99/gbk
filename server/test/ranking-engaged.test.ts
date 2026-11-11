// Ranker "engaged" label, training-row filters and point-in-time popularity (docs/social/ranking.md).
import test from "node:test";
import assert from "node:assert/strict";
import { Ranker, engaged, engagedSql, trainable, BURST_MIN, CI_IMPRESSIONS_STOPPED, type Imp } from "../src/ranking/ranker.ts";
import { fixture, H, D } from "./rank-fixture.ts";

const base = { completed: 0, replay: 0, listen_ratio: 0, dwell_ms: 5000, fast_skip: 0, actions: "[]" };
test("engaged: completion, replay, >= 25% listened, >= 10 s without fast skip, or any action; SQL agrees", () => {
  const cases: [Partial<typeof base>, number][] = [[{}, 0], [{ completed: 1 }, 1], [{ replay: 1 }, 1], [{ listen_ratio: 0.25 }, 1], [{ listen_ratio: 0.249 }, 0],
    [{ dwell_ms: 10_000 }, 1], [{ dwell_ms: 9_999 }, 0], [{ dwell_ms: 60_000, fast_skip: 1 }, 0], [{ dwell_ms: 0, actions: '["like"]' }, 1]];
  const fx = fixture(); const id = fx.song({ owner: "o" });
  for (const [c, want] of cases) {
    const r = { ...base, ...c }; assert.equal(engaged(r), want, JSON.stringify(c));
    fx.db.prepare("DELETE FROM impressions").run();
    fx.db.prepare("INSERT INTO impressions (actor, session, share_id, dwell_ms, listen_ratio, completed, fast_skip, replay, actions, position, feed, model_version, client, created_at) VALUES ('a','s',?,?,?,?,?,?,?,0,'for_you','v','web',1)")
      .run(id, r.dwell_ms, r.listen_ratio, r.completed, r.fast_skip, r.replay, r.actions);
    assert.equal((fx.db.prepare(`SELECT ${engagedSql()} AS e FROM impressions`).get() as { e: number }).e, want, `sql ${JSON.stringify(c)}`);
  }
});

const imp = (o: Partial<Imp>): Imp => ({ actor: "a", session: "s", share_id: "x", dwell_ms: 5000, listen_ratio: 0, completed: 0, fast_skip: 0, replay: 0, actions: "[]", created_at: 0, feed: "for_you", position: 0, ...o });
test("trainable: For you only, no action-only rows, no scripted swipe bursts; a slow long session stays", () => {
  const burst = Array.from({ length: BURST_MIN }, (_, k) => imp({ session: "burst", created_at: k * 2000, dwell_ms: 1800, fast_skip: 1 }));
  const slow = Array.from({ length: BURST_MIN }, (_, k) => imp({ session: "slow", created_at: k * 30_000 }));
  const out = trainable([...burst, ...slow, imp({ feed: "new" }), imp({ position: -1, feed: "for_you" }), imp({ dwell_ms: 0, actions: '["rate"]' }), imp({ session: "one", created_at: 5 })]);
  assert.deepEqual([...new Set(out.map((i) => i.session))].sort(), ["one", "slow"]); assert.equal(out.length, BURST_MIN + 1);
  assert.ok(out.every((x, i) => i === 0 || out[i - 1].created_at <= x.created_at), "time-ordered");
});

test("trainable: drops pre-fix iOS CI installs (one impression in the window); real iOS users and later rows stay", () => {
  const pre = CI_IMPRESSIONS_STOPPED - H, post = CI_IMPRESSIONS_STOPPED + H;
  const out = trainable([imp({ actor: "ci", client: "ios", created_at: pre }), imp({ actor: "web1", client: "web", created_at: pre }), imp({ actor: "new", client: "ios", created_at: post }),
    ...[0, 1].map((k) => imp({ actor: "me", client: "ios", session: `m${k}`, created_at: pre - k * D }))]);
  assert.deepEqual(out.map((i) => i.actor).sort(), ["me", "me", "new", "web1"]);
});

test("dataset: features as of the impression's exact time, so earlier plays in the same session count (as when serving)", () => {
  const fx = fixture(); const a = fx.song({ owner: "oa", tags: ["lofi"] }), b = fx.song({ owner: "ob", tags: ["lofi"] }); const t = Math.floor(fx.now() / H) * H - 2 * H + 60_000;
  fx.imp({ actor: "v", session: "s1", song: a, at: t, good: true }); fx.imp({ actor: "v", session: "s1", song: b, at: t + 5 * 60_000, good: true });
  const rows = fx.db.prepare("SELECT * FROM impressions ORDER BY created_at").all() as Imp[];
  const { tr } = new Ranker(fx.db, fx.now).dataset(rows, Infinity); const si = 4; // FEATURES.indexOf("session")
  assert.equal(tr[0].x[si], 0, "no peeking at itself"); assert.ok(tr[1].x[si] > 0, `same-hour session signal ${tr[1].x[si]}`);
});

test("dataset drops self-impressions", () => {
  const fx = fixture(); const id = fx.song({ owner: "me" }); fx.imp({ actor: "me", song: id, at: fx.now() - H, good: true }); fx.imp({ actor: "you", song: id, at: fx.now() - H, good: true });
  const rows = fx.db.prepare("SELECT * FROM impressions").all() as Imp[];
  const { tr, ho } = new Ranker(fx.db, fx.now).dataset(rows, Infinity); assert.equal(ho.length, 0); assert.deepEqual(tr.map((r) => r.actor), ["you"]);
});

test("popularity is point-in-time: engaged plays by others in the 14 days before t, log-scaled to [0, 1]", () => {
  const fx = fixture(); const a = fx.song({ owner: "oa" }), b = fx.song({ owner: "ob" }), c = fx.song({ owner: "oc" });
  fx.crowd(a, 7, fx.now() - 2 * D); fx.crowd(b, 1, fx.now() - 2 * D);
  fx.imp({ actor: "ob", song: b, at: fx.now() - 2 * D, good: true }); // owner's own play: ignored
  fx.imp({ actor: "x", song: b, at: fx.now() - 3 * D, good: false, skip: true }); // not engaged
  fx.crowd(c, 9, fx.now() - 20 * D); // outside the window
  const rk = new Ranker(fx.db, fx.now); const pop = (asOf: number) => new Map(rk.features("v", null, asOf).map((x) => [x.song.id, x.f.popularity]));
  const now = pop(fx.now()); assert.equal(now.get(a), 1); assert.ok(Math.abs(now.get(b)! - Math.log1p(1) / Math.log1p(7)) < 1e-9); assert.equal(now.get(c), 0);
  const before = pop(fx.now() - 2 * D - H); assert.equal(before.get(a), 0, "later plays are not visible earlier"); assert.equal(before.get(b), 0);
});
