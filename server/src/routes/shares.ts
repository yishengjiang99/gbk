// Song sharing + forking. Uploading requires login + an explicit Share click (consent); viewing is public.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import type { SessionStore } from "../security/authentication.ts";
import type { RateLimiter } from "../security/rate-limit.ts";
import type { ShareStore } from "../persistence/shares.ts";
import { sanitizeSharedProject, SHARE_LIMITS, ShareValidationError } from "../../../src/agent/share-schema.ts";
import { currentSession, guardWrite } from "./agent.ts";

const RIFF = (b: Uint8Array) => b.length > 44 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WAVE";
const MTHD = (b: Uint8Array) => b.length > 14 && String.fromCharCode(...b.subarray(0, 4)) === "MThd";

export function shareRoutes(app: FastifyInstance, cfg: Config, sessions: SessionStore, store: ShareStore, uploadLimiter: RateLimiter) {
  const origin = cfg.publicOrigin;
  app.addContentTypeParser(["audio/wav", "audio/midi", "application/octet-stream"], { parseAs: "buffer", bodyLimit: SHARE_LIMITS.wavBytes }, (_req, body, done) => done(null, body));

  app.post("/api/shares", { bodyLimit: SHARE_LIMITS.projectJsonBytes + 4096 }, async (req, reply) => {
    const s = currentSession(req, sessions);
    if (!s) return reply.code(401).send({ code: "UNAUTHENTICATED", message: "log in to share" });
    if (!guardWrite(cfg, req, reply, s)) return;
    if (!uploadLimiter.take(s.user) || store.countRecent(s.user, 86_400_000) >= 100) return reply.code(429).send({ code: "RATE_LIMITED", message: "too many shares; try later" });
    const b = (req.body ?? {}) as { title?: unknown; project?: unknown; parentSlug?: unknown };
    let project;
    try { project = sanitizeSharedProject(b.project); } catch (e) { if (e instanceof ShareValidationError) return reply.code(422).send({ code: e.code, message: e.message }); throw e; }
    const title = (typeof b.title === "string" && b.title.trim() ? b.title.trim() : project.name).slice(0, SHARE_LIMITS.titleChars);
    const parentSlug = typeof b.parentSlug === "string" ? b.parentSlug : null;
    const row = store.create({ owner: s.user, title, projectJson: JSON.stringify(project), parentSlug });
    req.log.info({ evt: "share_create", user: s.user, slug: row.slug, parent: row.parent_id });
    return { ...store.view(row), url: `${origin}/s/${row.slug}` };
  });

  app.put("/api/shares/:slug/media/:kind", { bodyLimit: SHARE_LIMITS.wavBytes }, async (req, reply) => {
    const s = currentSession(req, sessions);
    if (!s) return reply.code(401).send({ code: "UNAUTHENTICATED", message: "log in" });
    if (!guardWrite(cfg, req, reply, s)) return;
    const { slug, kind } = req.params as { slug: string; kind: string };
    const row = store.bySlug(slug);
    if (!row || row.owner !== s.user) return reply.code(404).send({ code: "NOT_FOUND", message: "no such share of yours" });
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf)) return reply.code(415).send({ code: "BAD_TYPE", message: "send raw bytes" });
    if (kind === "wav") { if (!RIFF(buf)) return reply.code(422).send({ code: "INVALID_WAV", message: "not a RIFF/WAVE file" }); }
    else if (kind === "midi") { if (buf.length > SHARE_LIMITS.midiBytes || !MTHD(buf)) return reply.code(422).send({ code: "INVALID_MIDI", message: "not a Standard MIDI File or too large" }); }
    else return reply.code(404).send({ code: "NOT_FOUND", message: "kind must be wav or midi" });
    const metaHdr = req.headers["x-gbk-wav-meta"];
    let meta: unknown = null; if (typeof metaHdr === "string") { try { meta = JSON.parse(metaHdr.slice(0, 2000)); } catch { meta = null; } }
    store.setMedia(slug, kind, new Uint8Array(buf), kind === "wav" ? { bytes: buf.length, ...(meta && typeof meta === "object" ? meta : {}) } : undefined);
    return { ok: true, bytes: buf.length };
  });

  app.get("/api/shares", async (req) => {
    const q = req.query as { mine?: string; limit?: string; offset?: string };
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 30)); const offset = Math.max(0, Number(q.offset) || 0);
    const s = q.mine ? currentSession(req, sessions) : null;
    return { shares: store.list({ owner: q.mine ? (s?.user ?? "\u0000none") : undefined, limit, offset }) };
  });

  const visible = (req: FastifyRequest, slug: string) => {
    const row = store.bySlug(slug); if (!row) return null;
    if (row.public) return row;
    const s = currentSession(req, sessions); return s && s.user === row.owner ? row : null;
  };
  app.get("/api/shares/:slug", async (req, reply) => {
    const row = visible(req, (req.params as { slug: string }).slug);
    if (!row) return reply.code(404).send({ code: "NOT_FOUND", message: "this song is not shared (or was removed)" });
    const s = currentSession(req, sessions);
    return { ...store.view(row), url: `${origin}/s/${row.slug}`, mine: !!s && s.user === row.owner, project: JSON.parse(row.project_json) };
  });
  app.get("/api/shares/:slug/media/:kind", async (req, reply) => {
    const { slug, kind } = req.params as { slug: string; kind: string };
    const row = visible(req, slug);
    const bytes = row ? (kind === "wav" ? row.wav : kind === "midi" ? row.midi : null) : null;
    if (!row || !bytes) return reply.code(404).send({ code: "NOT_FOUND", message: "no such media" });
    reply.header("content-type", kind === "wav" ? "audio/wav" : "audio/midi").header("x-content-type-options", "nosniff").header("content-disposition", `inline; filename="${row.slug}.${kind === "wav" ? "wav" : "mid"}"`).header("cache-control", "public, max-age=300");
    return reply.send(Buffer.from(bytes));
  });
  app.patch("/api/shares/:slug", async (req, reply) => {
    const s = currentSession(req, sessions);
    if (!s) return reply.code(401).send({ code: "UNAUTHENTICATED", message: "log in" });
    if (!guardWrite(cfg, req, reply, s)) return;
    const row = store.bySlug((req.params as { slug: string }).slug);
    if (!row || row.owner !== s.user) return reply.code(404).send({ code: "NOT_FOUND", message: "no such share of yours" });
    const pub = (req.body as { public?: unknown } | null)?.public;
    if (typeof pub !== "boolean") return reply.code(400).send({ code: "INVALID_ARGUMENT", message: "public must be boolean" });
    store.setPublic(row.slug, pub); return store.view(store.bySlug(row.slug)!);
  });
  app.delete("/api/shares/:slug", async (req, reply) => {
    const s = currentSession(req, sessions);
    if (!s) return reply.code(401).send({ code: "UNAUTHENTICATED", message: "log in" });
    if (!guardWrite(cfg, req, reply, s)) return;
    const row = store.bySlug((req.params as { slug: string }).slug);
    if (!row || row.owner !== s.user) return reply.code(404).send({ code: "NOT_FOUND", message: "no such share of yours" });
    store.delete(row.slug); req.log.info({ evt: "share_delete", user: s.user, slug: row.slug }); return { ok: true, deleted: row.slug };
  });
}
