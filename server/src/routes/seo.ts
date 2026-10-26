// Crawlability: live /sitemap.xml (index + child sitemaps past 45k URLs) built from the DB, and
// server-side meta injection (title, description, canonical, og/twitter) into the SPA shell for /s/<slug>
// and /u/<handle>. Only public songs and profiles with public songs (or AI artists) are listed.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import { PAGE_PATHS } from "./pages.ts";

export const SITEMAP_CHUNK = 45_000;
export const STATIC_PATHS = ["/", "/feed", "/explore", ...PAGE_PATHS, "/chatgpt/gallery", "/pricing", "/plans"];
export const xmlEsc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const htmlEsc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const iso = (ms: number | null | undefined) => (ms ? new Date(Number(ms)).toISOString() : null);

interface Entry { loc: string; lastmod: string | null }

export function sitemapEntries(db: DatabaseSync, origin: string): { pages: Entry[]; songs: Entry[] } {
  const songs = (db.prepare("SELECT slug, COALESCE(updated_at, published_at, created_at) AS m FROM shares WHERE public = 1 ORDER BY created_at DESC, id").all() as { slug: string; m: number }[])
    .map((r) => ({ loc: `${origin}/s/${encodeURIComponent(r.slug)}`, lastmod: iso(r.m) }));
  const profiles = (db.prepare(`SELECT p.handle, (SELECT MAX(COALESCE(s.updated_at, s.published_at, s.created_at)) FROM shares s WHERE s.owner = p.user_id AND s.public = 1) AS m, p.badge
    FROM profiles p ORDER BY p.handle`).all() as { handle: string; m: number | null; badge: string | null }[])
    .filter((r) => r.m != null || r.badge === "AI artist")
    .map((r) => ({ loc: `${origin}/u/${encodeURIComponent(r.handle)}`, lastmod: iso(r.m) }));
  return { pages: [...STATIC_PATHS.map((p) => ({ loc: `${origin}${p}`, lastmod: null })), ...profiles], songs };
}

const urlset = (es: Entry[]) => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${es.map((e) => `  <url><loc>${xmlEsc(e.loc)}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ""}</url>`).join("\n")}\n</urlset>\n`;

function sendXml(req: FastifyRequest, reply: FastifyReply, body: string) {
  const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
  reply.header("cache-control", "public, max-age=3600").header("etag", etag);
  if (req.headers["if-none-match"] === etag) return reply.code(304).send();
  return reply.type("application/xml; charset=utf-8").send(body);
}

export function seoRoutes(app: FastifyInstance, cfg: Config, db: DatabaseSync, opts: { chunk?: number; shellFile?: string } = {}) {
  const chunk = opts.chunk ?? SITEMAP_CHUNK, origin = cfg.publicOrigin;
  app.get("/sitemap.xml", async (req, reply) => {
    const { pages, songs } = sitemapEntries(db, origin);
    if (pages.length + songs.length <= chunk) return sendXml(req, reply, urlset([...pages, ...songs]));
    const n = Math.ceil(songs.length / chunk);
    const locs = [`${origin}/sitemap-pages.xml`, ...Array.from({ length: n }, (_, i) => `${origin}/sitemap-songs-${i + 1}.xml`)];
    return sendXml(req, reply, `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs.map((l) => `  <sitemap><loc>${xmlEsc(l)}</loc></sitemap>`).join("\n")}\n</sitemapindex>\n`);
  });
  app.get("/sitemap-pages.xml", async (req, reply) => sendXml(req, reply, urlset(sitemapEntries(db, origin).pages)));
  app.get("/sitemap-songs-:n.xml", async (req, reply) => {
    const n = Number((req.params as { n: string }).n);
    const songs = sitemapEntries(db, origin).songs.slice((n - 1) * chunk, n * chunk);
    if (!Number.isInteger(n) || n < 1 || !songs.length) return reply.code(404).send("not found");
    return sendXml(req, reply, urlset(songs));
  });

  // SPA shell with per-page meta. The built index.html lives in dist/ under the service WorkingDirectory.
  let shell: string | null = null;
  const loadShell = () => {
    if (shell) return shell;
    try { shell = readFileSync(opts.shellFile ?? join(process.cwd(), "dist", "index.html"), "utf8"); } catch { return null; }
    return shell;
  };
  const render = (reply: FastifyReply, m: { title: string; description: string; url: string; index: boolean; type?: string }) => {
    const base = loadShell();
    if (!base) return reply.code(503).send("shell unavailable");
    const t = htmlEsc(m.title), d = htmlEsc(m.description), u = htmlEsc(m.url);
    const html = base
      .replace(/<title>[\s\S]*?<\/title>/, `<title>${t}</title>`)
      .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${d}" />`)
      .replace(/<meta property="og:type"[^>]*>/, `<meta property="og:type" content="${m.type ?? "website"}" />`)
      .replace(/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="${t}" />`)
      .replace(/<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${d}" />`)
      .replace(/<meta name="twitter:title"[^>]*>/, `<meta name="twitter:title" content="${t}" />`)
      .replace(/<meta name="twitter:description"[^>]*>/, `<meta name="twitter:description" content="${d}" />`)
      .replace(/<link rel="canonical"[^>]*>\s*/g, "").replace(/<meta property="og:url"[^>]*>\s*/g, "")
      .replace("</head>", `  <link rel="canonical" href="${u}" />\n    <meta property="og:url" content="${u}" />\n    <meta name="robots" content="${m.index ? "index,follow" : "noindex"}" />\n  </head>`);
    return reply.type("text/html; charset=utf-8").header("cache-control", "no-cache").send(html);
  };
  const songQ = db.prepare(`SELECT s.title, s.slug, s.owner, s.labels, s.prompt_shared, s.prompt_text, p.handle, p.display_name FROM shares s LEFT JOIN profiles p ON p.user_id = s.owner WHERE s.slug = ? AND s.public = 1`);
  app.get("/s/:slug", async (req, reply) => {
    const slug = (req.params as { slug: string }).slug;
    const r = songQ.get(slug) as { title: string; slug: string; labels: string; prompt_shared: number; prompt_text: string | null; handle: string | null; display_name: string | null } | undefined;
    if (!r) return render(reply, { title: "GBK Composer", description: "Compose, edit and share MIDI music.", url: `${origin}/s/${encodeURIComponent(slug)}`, index: false });
    let labels: string[] = []; try { labels = JSON.parse(r.labels || "[]"); } catch { /* ignore */ }
    const by = r.display_name ? ` by ${r.display_name}` : "";
    const desc = [`${r.title}${by}: an original song made with GBK Composer. Listen, remix, and download the MIDI.`, labels.length ? `Genre: ${labels.join(", ")}.` : "", r.prompt_shared && r.prompt_text ? `Prompt: ${r.prompt_text}` : ""].filter(Boolean).join(" ").slice(0, 300);
    return render(reply, { title: `${r.title}${by} · GBK Composer`, description: desc, url: `${origin}/s/${encodeURIComponent(r.slug)}`, index: true, type: "music.song" });
  });
  const profQ = db.prepare(`SELECT p.handle, p.display_name, p.bio, p.badge, (SELECT COUNT(*) FROM shares s WHERE s.owner = p.user_id AND s.public = 1) AS n FROM profiles p WHERE p.handle = ?`);
  app.get("/u/:handle", async (req, reply) => {
    const h = String((req.params as { handle: string }).handle).toLowerCase().slice(0, 40);
    const p = profQ.get(h) as { handle: string; display_name: string; bio: string | null; badge: string | null; n: number } | undefined;
    const url = `${origin}/u/${encodeURIComponent(h)}`;
    if (!p || (!Number(p.n) && p.badge !== "AI artist")) return render(reply, { title: "GBK Composer", description: "Compose, edit and share MIDI music.", url, index: false });
    const desc = (p.bio ? `${p.bio} ` : "") + `${Number(p.n)} public song${Number(p.n) === 1 ? "" : "s"} by ${p.display_name}${p.badge ? ` (${p.badge})` : ""} on GBK Composer.`;
    return render(reply, { title: `${p.display_name} (@${p.handle}) · GBK Composer`, description: desc.slice(0, 300), url, index: true, type: "profile" });
  });
}
