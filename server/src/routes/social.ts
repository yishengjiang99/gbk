// gbk Social P1 routes: /api/me, /api/users/:handle, /api/feed, tags, ratings, comments, plays, reports, admin queue.
// JSON for web + native iOS (cookie or Bearer). Contract: docs/social-api.md.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isGuestAccount } from "../persistence/accounts.ts";
import type { Config } from "../config.ts";
import type { SessionStore } from "../security/authentication.ts";
import type { ShareStore, ShareRow } from "../persistence/shares.ts";
import type { AccountStore } from "../persistence/accounts.ts";
import { SocialStore, encCursor, decCursor, normLabels, normTags, badText, LABELS, TAG_RE, type CommentRow } from "../persistence/social.ts";
import { RateLimiter } from "../security/rate-limit.ts";
import { currentSession, guardWrite } from "./agent.ts";
import { parseCookies } from "../security/authentication.ts";
import { isGuest } from "../mcp/guest.ts";

/** Ranker that produced the feed; clients echo it on every impression (docs/social/ranking.md). */
export const MODEL_VERSION = "heur-1";
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const lim = (v: unknown, d = 20, max = 50) => Math.min(max, Math.max(1, Number(v) || d));

export const OWNER_HANDLE = "yishengjiang";
export function socialRoutes(app: FastifyInstance, cfg: Config, sessions: SessionStore, shares: ShareStore, accounts: AccountStore, social: SocialStore, notify?: import("../push/notifier.ts").Notify, ranker?: import("../ranking/ranker.ts").Ranker, iap?: import("../persistence/iap.ts").IapStore, limits?: import("../agent/limits.ts").AccountLimits) {
  const origin = cfg.publicOrigin;
  const L = { comment: new RateLimiter(10), rating: new RateLimiter(60), report: new RateLimiter(10, 3_600_000), play: new RateLimiter(120) };
  const limited = (reply: FastifyReply, l: RateLimiter, key: string) => { if (l.take(key)) return false; void reply.code(429).header("retry-after", String(l.retryAfterSec(key))).send({ code: "RATE_LIMITED", message: "slow down" }); return true; };
  const nameOf = (u: string) => accounts.get(u)?.name || u;
  const prof = (u: string) => social.ensureProfile(u, nameOf(u));
  const user = (u: string) => { const p = prof(u); return { handle: p.handle, display_name: p.display_name, bio: p.bio ?? null, badge: p.badge ?? null, avatar_url: null, ...social.userStats(u), created_at: p.created_at }; };
  const guestComments = new RateLimiter(20, 86_400_000);
  const me = (u: string) => { const p = prof(u); const a = accounts.get(u); return { ...user(u), id: u, provider: a?.provider ?? null, is_guest: a?.provider === "guest", ...(() => { const e = iap?.pro(u); const src = e?.pro ? "apple" : limits?.proSource(u) ?? null; return { pro: !!src, pro_source: src, pro_expires_at: src === "apple" ? e?.expires_at ?? null : null, pro_environment: src === "apple" ? e?.environment ?? null : null }; })(), dm_policy: p.dm_policy, handle_changed: !!p.handle_changed, is_admin: cfg.adminUsers.includes(u) }; };
  /** Signed-in, non-guest account required for social writes. */
  const auth = (req: FastifyRequest, reply: FastifyReply, write = true) => {
    const s = currentSession(req, sessions);
    if (!s || isGuest(s.user)) { void reply.code(401).send({ code: "UNAUTHENTICATED", message: "sign in first" }); return null; }
    if (write && !guardWrite(cfg, req, reply, s)) return null;
    return s;
  };
  const song = (r: ShareRow, viewer: string | null) => {
    const x = social.social(r.id); const parent = r.parent_id ? shares.byId(r.parent_id) : null;
    return { slug: r.slug, title: r.title, url: `${origin}/s/${r.slug}`, author: user(r.owner), created_at: r.created_at, published_at: x.published_at,
      labels: JSON.parse(x.labels || "[]") as string[], tags: social.tagsOf(r.id),
      rating_avg: x.rating_count ? Math.round((x.rating_sum / x.rating_count) * 10) / 10 : null, rating_count: x.rating_count, comment_count: x.comment_count, play_count: x.play_count, fork_count: Number(x.forks),
      my_rating: viewer ? social.myRating(r.id, viewer) : null,
      media: { mp3: r.mp3 ? `${origin}/api/shares/${r.slug}/media/mp3` : null, wav: r.wav ? `${origin}/api/shares/${r.slug}/media/wav` : null, midi: r.midi ? `${origin}/api/shares/${r.slug}/media/midi` : null },
      preview: shares.preview(r.id), prompt_shared: !!x.prompt_shared, prompt_text: x.prompt_shared ? x.prompt_text : null,
      parent_slug: parent?.public ? parent.slug : null, is_mine: viewer === r.owner };
  };
  const viewerOf = (req: FastifyRequest) => { const s = currentSession(req, sessions); return s && !isGuest(s.user) ? s.user : null; };
  const pubSong = (slug: string) => { const r = shares.bySlug(slug); return r && r.public ? r : null; };

  // ---- me / profiles ----
  app.get("/api/me", async (req, reply) => { const s = auth(req, reply, false); if (!s) return; await limits?.refresh(s.user); return me(s.user); });
  app.patch("/api/me/settings", async (req, reply) => {
    const s = auth(req, reply); if (!s) return; prof(s.user);
    const b = (req.body ?? {}) as { display_name?: unknown; handle?: unknown; dm_policy?: unknown };
    const o: { display_name?: string; handle?: string; dm_policy?: string } = {};
    if (b.display_name !== undefined) { if (typeof b.display_name !== "string" || !b.display_name.trim() || b.display_name.length > 40 || badText(b.display_name)) return reply.code(422).send({ code: "INVALID_NAME", message: "1-40 characters" }); o.display_name = b.display_name.trim(); }
    if (b.handle !== undefined) { const h = String(b.handle).toLowerCase(); if (!HANDLE_RE.test(h) || badText(h)) return reply.code(422).send({ code: "INVALID_HANDLE", message: "3-20 of a-z, 0-9, _" }); o.handle = h; }
    if (b.dm_policy !== undefined) { if (b.dm_policy !== "all" && b.dm_policy !== "off") return reply.code(422).send({ code: "INVALID_ARGUMENT", message: "dm_policy is all or off" }); o.dm_policy = b.dm_policy; }
    if (isGuestAccount(s.user) && ((o.display_name !== undefined && !/^[A-Z][a-z]{1,11}[A-Z][a-z]{1,11}$/.test(o.display_name)) || (o.handle !== undefined && !/^[a-z]{4,20}[0-9]{0,3}$/.test(o.handle)))) return reply.code(422).send({ code: "INVALID_USERNAME", message: "guests use two capitalized words, letters only (sign in to choose freely)" });
    const r = social.updateProfile(s.user, o);
    if (r === "HANDLE_TAKEN") return reply.code(409).send({ code: r, message: "that handle is taken" });
    if (r === "HANDLE_LOCKED") return reply.code(403).send({ code: r, message: "handle can only be changed once" });
    return me(s.user);
  });
  app.get("/api/users/:handle", async (req, reply) => {
    const p = social.byHandle((req.params as { handle: string }).handle);
    if (!p) return reply.code(404).send({ code: "NOT_FOUND", message: "no such user" });
    const q = req.query as { cursor?: string; limit?: string }; const v = viewerOf(req);
    const f = social.feed({ sort: "new", owner: p.user_id, cursor: q.cursor, limit: lim(q.limit) });
    return { user: user(p.user_id), songs: f.ids.map((id) => song(shares.byId(id)!, v)), next_cursor: f.next };
  });

  // ---- feed / tags ----
  const feed = async (req: FastifyRequest, reply: FastifyReply, tag?: string) => {
    const q = req.query as { sort?: string; label?: string; tag?: string; cursor?: string; limit?: string };
    const sort = q.sort === "new" || q.sort === "top" ? q.sort : "for_you";
    const label = q.label && (LABELS as readonly string[]).includes(q.label) ? q.label : undefined;
    const t = tag ?? q.tag; if (t !== undefined && !TAG_RE.test(t)) return reply.code(400).send({ code: "INVALID_TAG", message: "bad tag" });
    // Personalized For you (no filters): ranked list + offset cursor carrying the seed, so pages stay consistent.
    if (sort === "for_you" && !label && t === undefined && ranker) {
      const v = viewerOf(req); const n = lim(q.limit); const c = decCursor<{ r?: number; p?: number; sd?: number; t?: number }>(q.cursor);
      const ck = parseCookies(req.headers.cookie).gbk_gid; const inst = String(req.headers["x-gbk-install"] ?? "");
      const actor = v ?? (ck && /^[A-Za-z0-9_-]{8,64}$/.test(ck) ? `gid:${ck}` : /^[A-Za-z0-9_-]{8,64}$/.test(inst) ? `inst:${inst}` : null);
      const session = typeof (req.query as { session?: string }).session === "string" ? (req.query as { session: string }).session.slice(0, 64) : null;
      const seed = c?.r === 1 && typeof c.sd === "number" ? c.sd : Math.floor(Math.random() * 2 ** 31); const p0 = c?.r === 1 && typeof c.p === "number" ? Math.max(0, c.p) : 0;
      // t: the first page's time; later pages rank as of it so they never duplicate or drop songs (older cursors: now)
      const asOf = c?.r === 1 && typeof c.t === "number" ? Math.min(Date.now(), c.t) : Date.now();
      const rk = ranker.rank({ actor, session, seed, viewer: v, asOf });
      const page = rk.ids.slice(p0, p0 + n).map((id) => shares.byId(id)).filter((r): r is ShareRow => !!r && !!r.public);
      return { items: page.map((r) => song(r, v)), next_cursor: p0 + n < rk.ids.length ? encCursor({ r: 1, p: p0 + n, sd: seed, t: asOf }) : null, model_version: rk.version };
    }
    const f = social.feed({ sort, label, tag: t, cursor: q.cursor, limit: lim(q.limit) }); const v = viewerOf(req);
    // Light diversity on For you: never more than 2 consecutive songs by one author, across pages too. We read a
    // look-ahead window, pick greedily, and the cursor carries the last two authors (o) plus the ids already shown
    // past the cursor position (x) so deferred songs come on a later page instead of being dropped.
    let rows = f.ids.map((id) => shares.byId(id)!); let next = f.next;
    if (sort === "for_you") {
      const c0 = decCursor<{ o?: unknown; x?: unknown }>(q.cursor) ?? {};
      const hist = (Array.isArray(c0.o) ? c0.o : []).filter((x): x is string => typeof x === "string").slice(-2);
      const shown = new Set((Array.isArray(c0.x) ? c0.x : []).filter((x): x is string => typeof x === "string"));
      const n = lim(q.limit); const w = social.feed({ sort, label, tag: t, cursor: q.cursor, limit: n * 3 + shown.size });
      const win = w.rows.filter((r) => !shown.has(r.id)).map((r) => ({ ...r, row: shares.byId(r.id)! }));
      const out: typeof win = []; const owners = () => [...hist, ...out.map((r) => r.row.owner)];
      const bad = (o: string) => { const t2 = owners(); return t2.length >= 2 && t2[t2.length - 1] === o && t2[t2.length - 2] === o; };
      while (out.length < n && out.length < win.length) {
        const pick = win.find((r) => !out.includes(r) && !bad(r.row.owner)) ?? (w.more ? null : win.find((r) => !out.includes(r)));
        if (!pick) break; out.push(pick);
      }
      rows = out.map((r) => r.row);
      const firstSkip = win.findIndex((r) => !out.includes(r));
      const restAfter = firstSkip === -1 ? [] : win.slice(firstSkip);
      const hasMore = w.more || restAfter.length > 0;
      if (!hasMore || !out.length) next = null;
      else {
        const pos = firstSkip === -1 ? win[win.length - 1] : firstSkip > 0 ? win[firstSkip - 1] : null;
        const base = pos ? { k: pos.k, id: pos.id } : (decCursor<{ k?: number; id?: string }>(q.cursor) ?? {});
        const x = [...shown, ...restAfter.filter((r) => out.includes(r)).map((r) => r.id)].filter((id) => firstSkip !== -1 && win.slice(firstSkip).some((r) => r.id === id) || shown.has(id));
        next = encCursor({ ...("k" in base ? base : {}), o: owners().slice(-2), x: x.slice(-200) });
      }
    }
    return { items: rows.map((r) => song(r, v)), next_cursor: next, model_version: sort === "for_you" ? MODEL_VERSION : `${sort}-1` };
  };
  app.get("/api/feed", (req, reply) => feed(req, reply));
  app.get("/api/tags/top", async (req) => social.topTags(lim((req.query as { limit?: string }).limit, 30, 100)));
  app.get("/api/tags/:tag", (req, reply) => feed(req, reply, String((req.params as { tag: string }).tag).toLowerCase()));
  app.get("/api/songs/:slug", async (req, reply) => {
    const r = shares.bySlug((req.params as { slug: string }).slug); const v = viewerOf(req);
    if (!r || (!r.public && r.owner !== v)) return reply.code(404).send({ code: "NOT_FOUND", message: "no such song" });
    return song(r, v);
  });
  app.patch("/api/songs/:slug/meta", async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const r = shares.bySlug((req.params as { slug: string }).slug);
    if (!r || r.owner !== s.user) return reply.code(404).send({ code: "NOT_FOUND", message: "no such song of yours" });
    const b = (req.body ?? {}) as { labels?: unknown; tags?: unknown; prompt_shared?: unknown; prompt_text?: unknown };
    const labels = b.labels === undefined ? undefined : normLabels(b.labels); if (labels === null) return reply.code(422).send({ code: "INVALID_LABELS", message: `up to 3 of: ${LABELS.join(", ")}` });
    const tags = b.tags === undefined ? undefined : normTags(b.tags); if (tags === null || tags?.some(badText)) return reply.code(422).send({ code: "INVALID_TAGS", message: "up to 10 tags, 2-24 chars of a-z 0-9 -" });
    if (b.prompt_shared !== undefined && typeof b.prompt_shared !== "boolean") return reply.code(400).send({ code: "INVALID_ARGUMENT", message: "prompt_shared must be boolean" });
    if (b.prompt_text !== undefined && b.prompt_text !== null && (typeof b.prompt_text !== "string" || b.prompt_text.length > 4000)) return reply.code(422).send({ code: "INVALID_TEXT", message: "prompt_text up to 4000 chars" });
    social.setMeta(r.id, { labels, tags, prompt_shared: b.prompt_shared as boolean | undefined, prompt_text: b.prompt_text === undefined ? undefined : (b.prompt_text as string | null) });
    return song(shares.byId(r.id)!, s.user);
  });
  app.post("/api/shares/:slug/play", async (req, reply) => {
    const r = pubSong((req.params as { slug: string }).slug); if (!r) return reply.code(404).send({ code: "NOT_FOUND", message: "no such song" });
    const who = viewerOf(req) ?? `ip:${req.ip}`; if (limited(reply, L.play, who)) return;
    social.play(r.id, who); return { play_count: social.social(r.id).play_count };
  });

  // ---- ratings ----
  const rateResp = (id: string, u: string) => { const x = social.social(id); return { rating_avg: x.rating_count ? Math.round((x.rating_sum / x.rating_count) * 10) / 10 : null, rating_count: x.rating_count, my_rating: social.myRating(id, u) }; };
  app.put("/api/shares/:slug/rating", async (req, reply) => {
    const s = auth(req, reply); if (!s) return; if (limited(reply, L.rating, s.user)) return;
    const r = pubSong((req.params as { slug: string }).slug); if (!r) return reply.code(404).send({ code: "NOT_FOUND", message: "no such song" });
    if (r.owner === s.user) return reply.code(403).send({ code: "FORBIDDEN", message: "you can't rate your own song" });
    const stars = Number((req.body as { stars?: unknown } | null)?.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) return reply.code(422).send({ code: "INVALID_STARS", message: "stars is 1-5" });
    social.rate(r.id, s.user, stars); return rateResp(r.id, s.user);
  });
  app.delete("/api/shares/:slug/rating", async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const r = pubSong((req.params as { slug: string }).slug); if (!r) return reply.code(404).send({ code: "NOT_FOUND", message: "no such song" });
    social.rate(r.id, s.user, null); return rateResp(r.id, s.user);
  });

  // ---- comments ----
  const comment = (c: CommentRow, v: string | null, owner: string) => ({ id: String(c.id), author: user(c.user_id), body: c.body, created_at: c.created_at, can_delete: !!v && (v === c.user_id || v === owner) });
  app.get("/api/shares/:slug/comments", async (req, reply) => {
    const r = pubSong((req.params as { slug: string }).slug); if (!r) return reply.code(404).send({ code: "NOT_FOUND", message: "no such song" });
    const q = req.query as { order?: string; cursor?: string; limit?: string }; const v = viewerOf(req);
    const c = social.comments(r.id, { order: q.order === "old" ? "old" : "new", cursor: q.cursor, limit: lim(q.limit), viewer: v });
    return { items: c.rows.map((x) => comment(x, v, r.owner)), next_cursor: c.next };
  });
  app.post("/api/shares/:slug/comments", async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const r = pubSong((req.params as { slug: string }).slug); if (!r) return reply.code(404).send({ code: "NOT_FOUND", message: "no such song" });
    const body = String((req.body as { body?: unknown } | null)?.body ?? "").trim();
    if (!body || body.length > 500) return reply.code(422).send({ code: "INVALID_TEXT", message: "comment is 1-500 characters" });
    if (badText(body)) return reply.code(422).send({ code: "INVALID_TEXT", message: "please keep it kind" });
    if (isGuestAccount(s.user) && !guestComments.take(s.user)) return reply.code(429).header("retry-after", String(guestComments.retryAfterSec(s.user))).send({ code: "RATE_LIMITED", message: "guests can post 20 comments a day; sign in to lift the limit" });
    if (limited(reply, L.comment, s.user)) return;
    if (social.countComments(s.user, 86_400_000) >= 100) return reply.code(429).send({ code: "RATE_LIMITED", message: "daily comment limit reached" });
    const c = social.addComment(r.id, s.user, body); req.log.info({ evt: "comment_create", user: s.user, slug: r.slug });
    if (r.owner !== s.user && !social.blocked(r.owner, s.user)) notify?.(r.owner, { kind: "comment", title: `@${prof(s.user).handle} commented on ${r.title}`, body, link: `${origin}/s/${r.slug}` });
    return comment(c, s.user, r.owner);
  });
  app.delete("/api/comments/:id", async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const c = social.comment(Number((req.params as { id: string }).id)); const r = c ? shares.byId(c.share_id) : null;
    if (!c || c.deleted_at || !r || (c.user_id !== s.user && r.owner !== s.user && !cfg.adminUsers.includes(s.user))) return reply.code(404).send({ code: "NOT_FOUND", message: "no such comment of yours" });
    social.removeComment(c.id, "deleted_at"); return { ok: true };
  });

  // ---- reports / admin ----
  app.post("/api/reports", async (req, reply) => {
    const s = auth(req, reply); if (!s) return;
    const b = (req.body ?? {}) as { kind?: unknown; target?: unknown; reason?: unknown };
    const kind = String(b.kind); const target = String(b.target ?? "").slice(0, 128); const reason = String(b.reason ?? "").trim().slice(0, 500);
    if (!["comment", "message", "song", "user"].includes(kind) || !target) return reply.code(422).send({ code: "INVALID_ARGUMENT", message: "kind is comment|message|song|user with a target" });
    const exists = kind === "comment" ? !!social.comment(Number(target)) : kind === "song" ? !!shares.bySlug(target) : kind === "user" ? !!social.byHandle(target) : true;
    if (!exists) return reply.code(404).send({ code: "NOT_FOUND", message: "nothing to report" });
    if (limited(reply, L.report, s.user)) return;
    const id = social.report({ reporter: s.user, kind, target, reason }); req.log.info({ evt: "report_create", kind, id });
    // Owner shortcut: a report whose reason is exactly "delete" from @yishengjiang (matched by user id) hides the target
    // immediately (reversible: comment hidden flag / song unpublished) and resolves the report.
    const owner = social.byHandle(OWNER_HANDLE)?.user_id;
    if (owner && s.user === owner && reason.toLowerCase() === "delete" && (kind === "comment" || kind === "song")) {
      if (kind === "comment") social.removeComment(Number(target), "hidden"); else shares.setPublic(target, false);
      social.resolveReport(id, "hidden"); req.log.info({ evt: "report_owner_delete", kind, id });
      return { ok: true, id: String(id), deleted: true, message: "Deleted" };
    }
    return { ok: true, id: String(id) };
  });
  const admin = (req: FastifyRequest, reply: FastifyReply, write: boolean) => { const s = auth(req, reply, write); if (!s) return null; if (!cfg.adminUsers.includes(s.user)) { void reply.code(403).send({ code: "FORBIDDEN", message: "admin only" }); return null; } return s; };
  const preview = (kind: string, target: string) => {
    if (kind === "comment") { const c = social.comment(Number(target)); return c ? { text: c.body, by: prof(c.user_id).handle, song: shares.byId(c.share_id)?.slug ?? null, hidden: !!c.hidden || !!c.deleted_at } : null; }
    if (kind === "song") { const r = shares.bySlug(target); return r ? { text: r.title, by: prof(r.owner).handle, song: r.slug, hidden: !r.public } : null; }
    if (kind === "user") { const p = social.byHandle(target); return p ? { text: p.display_name, by: p.handle, song: null, hidden: false } : null; }
    return null;
  };
  app.get("/api/admin/reports", async (req, reply) => {
    if (!admin(req, reply, false)) return; const q = req.query as { status?: string; cursor?: string };
    const st = q.status === "resolved" ? "hidden" : q.status === "dismissed" ? "dismissed" : "open";
    const r = social.reports({ status: st, cursor: q.cursor, limit: 50 });
    return { items: r.rows.map((x) => ({ id: String(x.id), kind: x.kind, target: x.target_id, reason: x.reason, reporter: prof(x.reporter).handle, status: x.status, created_at: x.created_at, preview: preview(x.kind, x.target_id) })), next_cursor: r.next };
  });
  app.post("/api/admin/reports/:id", async (req, reply) => {
    if (!admin(req, reply, true)) return; const rep = social.reportById(Number((req.params as { id: string }).id));
    if (!rep) return reply.code(404).send({ code: "NOT_FOUND", message: "no such report" });
    const action = (req.body as { action?: unknown } | null)?.action;
    if (action !== "hide" && action !== "dismiss") return reply.code(422).send({ code: "INVALID_ARGUMENT", message: "action is hide or dismiss" });
    if (action === "hide") { if (rep.kind === "comment") social.removeComment(Number(rep.target_id), "hidden"); if (rep.kind === "song") shares.setPublic(rep.target_id, false); }
    social.resolveReport(rep.id, action === "hide" ? "hidden" : "dismissed"); return { ok: true };
  });
  return { me };
}
