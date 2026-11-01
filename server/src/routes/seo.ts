// Crawlability: live /sitemap.xml (index + child sitemaps past 45k URLs) built from the DB, and
// server-side meta injection (title, description, canonical, og/twitter) into the SPA shell for /s/<slug>
// and /u/<handle>. Only public songs and profiles with public songs (or AI artists) are listed.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import { PAGE_PATHS } from "./pages.ts";
import { ogImage, OG_W, OG_H } from "../og-image.ts";
import { ogVideo, ogVideoEnabled } from "../og-video.ts";
import { RateLimiter } from "../security/rate-limit.ts";

export const SITEMAP_CHUNK = 45_000;
export const STATIC_PATHS = ["/", "/feed", "/explore", ...PAGE_PATHS, "/chatgpt/gallery", "/pricing", "/plans"];
export const xmlEsc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const htmlEsc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Smart App Banner app-argument: origin + the request path and query (fallback: the page URL). Commas are
 *  percent-encoded because they separate apple-itunes-app fields; the caller HTML-escapes. */
export const bannerArg = (origin: string, reqUrl: string | undefined, fallback: string) => {
  const u = reqUrl && reqUrl.startsWith("/") && !reqUrl.startsWith("//") ? `${origin}${reqUrl}` : fallback;
  return u.replace(/,/g, "%2C");
};
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

export function seoRoutes(app: FastifyInstance, cfg: Config, db: DatabaseSync, opts: { chunk?: number; shellFile?: string; ogDir?: string; proOf?: (userId: string) => boolean; ogVideo?: boolean; ffmpeg?: string; videoLimiter?: RateLimiter } = {}) {
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

  // SPA shell with per-page meta + crawlable body. The built index.html lives in dist/ under the service WorkingDirectory.
  // The server-rendered block sits inside #root, so createRoot().render() replaces it when the app mounts.
  let shell: string | null = null;
  const loadShell = () => {
    if (shell) return shell;
    try { shell = readFileSync(opts.shellFile ?? join(process.cwd(), "dist", "index.html"), "utf8"); } catch { return null; }
    return shell;
  };
  const ogDir = opts.ogDir ?? join(cfg.dataDir, "og-cache");
  interface Meta { title: string; description: string; url: string; index: boolean; type?: string; image?: string; extraHead?: string; jsonLd?: object; body?: string }
  const render = (reply: FastifyReply, m: Meta, req?: FastifyRequest) => {
    const base = loadShell();
    if (!base) return reply.code(503).send("shell unavailable");
    const t = htmlEsc(m.title), d = htmlEsc(m.description), u = htmlEsc(m.url);
    let html = base
      .replace(/<title>[\s\S]*?<\/title>/, `<title>${t}</title>`)
      .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${d}" />`)
      .replace(/<meta property="og:type"[^>]*>/, `<meta property="og:type" content="${m.type ?? "website"}" />`)
      .replace(/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="${t}" />`)
      .replace(/<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${d}" />`)
      .replace(/<meta name="twitter:title"[^>]*>/, `<meta name="twitter:title" content="${t}" />`)
      .replace(/<meta name="twitter:description"[^>]*>/, `<meta name="twitter:description" content="${d}" />`)
      // Smart App Banner "OPEN" hands app-argument to the app: the full URL of this page (query kept, e.g. ?edit=1).
      .replace(/(<meta name="apple-itunes-app" content="[^"]*?app-argument=)[^"]*"/, (_, pre: string) => `${pre}${htmlEsc(bannerArg(origin, req?.url, m.url))}"`)
      .replace(/<link rel="canonical"[^>]*>\s*/g, "").replace(/<meta property="og:url"[^>]*>\s*/g, "");
    if (m.image) {
      const img = htmlEsc(m.image);
      html = html.replace(/<meta property="og:image(:width|:height)?"[^>]*>\s*/g, "").replace(/<meta name="twitter:image"[^>]*>\s*/g, "")
        .replace("</head>", `  <meta property="og:image" content="${img}" />\n    <meta property="og:image:width" content="1200" />\n    <meta property="og:image:height" content="630" />\n    <meta property="og:image:alt" content="${t}" />\n    <meta name="twitter:image" content="${img}" />\n  </head>`);
    }
    if (m.jsonLd) html = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, `<script type="application/ld+json">${JSON.stringify(m.jsonLd).replace(/</g, "\\u003c")}</script>`);
    html = html.replace("</head>", `  <link rel="canonical" href="${u}" />\n    <meta property="og:url" content="${u}" />\n    <meta name="robots" content="${m.index ? "index,follow" : "noindex"}" />\n${m.extraHead ?? ""}${m.body ? `    <style>${SSR_CSS}</style>\n` : ""}  </head>`);
    if (m.body) html = html.replace(/<div id="root"><\/div>/, `<div id="root"><main class="ssr">${m.body}</main></div>`);
    return reply.type("text/html; charset=utf-8").header("cache-control", "no-cache").send(html);
  };
  const generic = (url: string): Meta => ({ title: "GBK Composer", description: "Compose, edit and share MIDI music.", url, index: false });

  const songQ = db.prepare(`SELECT s.id, s.title, s.slug, s.owner, s.labels, s.prompt_shared, s.prompt_text, s.wav_meta, s.project_json, s.created_at, s.published_at, s.updated_at,
    s.mp3 IS NOT NULL AS h3, p.handle, p.display_name FROM shares s LEFT JOIN profiles p ON p.user_id = s.owner WHERE s.slug = ? AND s.public = 1`);
  const tagsQ = db.prepare("SELECT tag FROM share_tags WHERE share_id = ? ORDER BY tag");
  const byOwnerQ = db.prepare("SELECT slug, title, labels, created_at, published_at FROM shares WHERE owner = ? AND public = 1 ORDER BY COALESCE(published_at, created_at) DESC LIMIT ?");
  type SongRow = { id: string; title: string; slug: string; owner: string; labels: string; prompt_shared: number; prompt_text: string | null; wav_meta: string | null; project_json: string; created_at: number; published_at: number | null; updated_at: number | null; h3: number; handle: string | null; display_name: string | null };
  const song = (slug: string) => songQ.get(slug) as SongRow | undefined;
  const labelsOf = (j: string): string[] => { try { const v = JSON.parse(j || "[]"); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
  const ogOf = (r: SongRow) => ({ slug: r.slug, title: r.title, artist: r.display_name ?? "GBK Composer", genre: labelsOf(r.labels).join(" · "), projectJson: r.project_json, rev: r.updated_at ?? r.created_at });

  const videoOn = opts.ogVideo ?? ogVideoEnabled(), videoL = opts.videoLimiter ?? new RateLimiter(20);
  const mp3Q = db.prepare("SELECT mp3 FROM shares WHERE slug = ? AND public = 1");
  app.get("/og/s/:file", async (req, reply) => {
    // Strict allowlist: [a-zA-Z0-9-] only, so no path separators or dots reach the filesystem.
    const m = /^([a-zA-Z0-9-]{1,140})\.(png|mp4)$/.exec((req.params as { file: string }).file);
    const r = m ? song(m[1]) : undefined;
    if (!r) return reply.code(404).send("not found");
    if (m![2] === "mp4") {
      if (!videoOn || !r.h3) return reply.code(404).send("not found");
      if (!videoL.take(req.ip)) return reply.code(429).header("retry-after", String(videoL.retryAfterSec(req.ip))).send("rate limited");
      const mp3 = (mp3Q.get(r.slug) as { mp3: Uint8Array | null } | undefined)?.mp3;
      if (!mp3) return reply.code(404).send("not found");
      let file: string;
      try { file = await ogVideo(ogDir, r.slug, ogImage(ogDir, ogOf(r)), mp3, opts.ffmpeg); }
      catch (e) { req.log.error({ err: e, slug: r.slug }, "og video render failed"); return reply.code(503).send("video unavailable"); }
      const size = statSync(file).size, buf = readFileSync(file);
      reply.type("video/mp4").header("accept-ranges", "bytes").header("cache-control", "public, max-age=86400").header("x-content-type-options", "nosniff");
      const rg = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
      if (!rg || (!rg[1] && !rg[2])) return reply.send(buf);
      let start = rg[1] ? Number(rg[1]) : size - Number(rg[2]), end = rg[1] && rg[2] ? Math.min(Number(rg[2]), size - 1) : size - 1;
      if (start < 0) start = 0;
      if (start >= size || start > end) return reply.code(416).header("content-range", `bytes */${size}`).send();
      return reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).send(buf.subarray(start, end + 1));
    }
    const png = readFileSync(ogImage(ogDir, ogOf(r)));
    return reply.type("image/png").header("cache-control", "public, max-age=86400").header("x-content-type-options", "nosniff").send(png);
  });

  app.get("/s/:slug", async (req, reply) => {
    const slug = (req.params as { slug: string }).slug;
    const r = song(slug);
    if (!r) return render(reply, generic(`${origin}/s/${encodeURIComponent(slug)}`), req);
    const url = `${origin}/s/${encodeURIComponent(r.slug)}`, labels = labelsOf(r.labels), tags = (tagsQ.all(r.id) as { tag: string }[]).map((x) => x.tag);
    const artist = r.display_name ?? "GBK Composer", artistUrl = r.handle ? `${origin}/u/${encodeURIComponent(r.handle)}` : null;
    const by = r.display_name ? ` by ${r.display_name}` : "";
    const prompt = r.prompt_shared && r.prompt_text ? r.prompt_text : null;
    const secs = durationSeconds(r.wav_meta, r.project_json), published = new Date(r.published_at ?? r.created_at);
    const desc = [`${r.title}${by}: an original song made with GBK Composer. Listen, remix, and download the MIDI.`, labels.length ? `Genre: ${labels.join(", ")}.` : "", prompt ? `Prompt: ${prompt}` : ""].filter(Boolean).join(" ").slice(0, 300);
    const image = `${origin}/og/s/${encodeURIComponent(r.slug)}.png`, audio = r.h3 ? `${origin}/api/shares/${encodeURIComponent(r.slug)}/media/mp3` : null;
    const video = `${origin}/og/s/${encodeURIComponent(r.slug)}.mp4`;
    const more = r.owner ? (byOwnerQ.all(r.owner, 11) as { slug: string; title: string }[]).filter((x) => x.slug !== r.slug).slice(0, 10) : [];
    const extraHead = [audio && `    <meta property="og:audio" content="${htmlEsc(audio)}" />\n    <meta property="og:audio:type" content="audio/mpeg" />\n`,
      audio && videoOn && [`    <meta property="og:video" content="${htmlEsc(video)}" />\n`, `    <meta property="og:video:secure_url" content="${htmlEsc(video)}" />\n`,
        `    <meta property="og:video:type" content="video/mp4" />\n`, `    <meta property="og:video:width" content="${OG_W}" />\n`, `    <meta property="og:video:height" content="${OG_H}" />\n`].join(""),
      artistUrl && `    <meta property="music:musician" content="${htmlEsc(artistUrl)}" />\n`, secs ? `    <meta property="music:duration" content="${Math.round(secs)}" />\n` : "",
      `    <meta property="music:release_date" content="${published.toISOString().slice(0, 10)}" />\n`].filter(Boolean).join("");
    const jsonLd = { "@context": "https://schema.org", "@type": "MusicRecording", name: r.title, url, image, datePublished: published.toISOString().slice(0, 10),
      byArtist: { "@type": "MusicGroup", name: artist, ...(artistUrl ? { url: artistUrl } : {}) }, ...(secs ? { duration: isoDuration(secs) } : {}),
      ...(labels.length ? { genre: labels } : {}), ...(tags.length ? { keywords: tags.join(", ") } : {}), ...(prompt ? { description: prompt } : {}),
      ...(audio ? { audio: { "@type": "AudioObject", contentUrl: audio, encodingFormat: "audio/mpeg", ...(secs ? { duration: isoDuration(secs) } : {}) } } : {}) };
    const a = (href: string, txt: string) => `<a href="${htmlEsc(href)}">${htmlEsc(txt)}</a>`;
    const body = `<h1>${htmlEsc(r.title)}</h1><p class="by">by ${artistUrl ? a(`/u/${encodeURIComponent(r.handle!)}`, artist) : htmlEsc(artist)}</p>
<dl>${labels.length ? `<dt>Genre</dt><dd>${htmlEsc(labels.join(", "))}</dd>` : ""}${tags.length ? `<dt>Tags</dt><dd>${tags.map((x) => `#${htmlEsc(x)}`).join(" ")}</dd>` : ""}${secs ? `<dt>Duration</dt><dd><time datetime="${isoDuration(secs)}">${clock(secs)}</time></dd>` : ""}<dt>Published</dt><dd><time datetime="${published.toISOString()}">${published.toISOString().slice(0, 10)}</time></dd></dl>
${prompt ? `<h2>Prompt</h2><blockquote>${htmlEsc(prompt)}</blockquote>` : ""}<p>${a(`/s/${encodeURIComponent(r.slug)}`, "Listen and remix in GBK Composer")}</p>
${more.length ? `<h2>More by ${htmlEsc(artist)}</h2><ul>${more.map((x) => `<li>${a(`/s/${encodeURIComponent(x.slug)}`, x.title)}</li>`).join("")}</ul>` : ""}`;
    return render(reply, { title: `${r.title}${by} · GBK Composer`, description: desc, url, index: true, type: "music.song", image, extraHead, jsonLd, body }, req);
  });

  const profQ = db.prepare(`SELECT p.user_id, p.handle, p.display_name, p.bio, p.badge, (SELECT COUNT(*) FROM shares s WHERE s.owner = p.user_id AND s.public = 1) AS n FROM profiles p WHERE p.handle = ?`);
  app.get("/u/:handle", async (req, reply) => {
    const h = String((req.params as { handle: string }).handle).toLowerCase().slice(0, 40);
    const p = profQ.get(h) as { user_id: string; handle: string; display_name: string; bio: string | null; badge: string | null; n: number } | undefined;
    const url = `${origin}/u/${encodeURIComponent(h)}`;
    if (!p || (!Number(p.n) && p.badge !== "AI artist")) return render(reply, generic(url), req);
    const n = Number(p.n), songs = byOwnerQ.all(p.user_id, 100) as { slug: string; title: string; labels: string; created_at: number; published_at: number | null }[];
    const desc = (p.bio ? `${p.bio} ` : "") + `${n} public song${n === 1 ? "" : "s"} by ${p.display_name}${p.badge ? ` (${p.badge})` : ""} on GBK Composer.`;
    const latest = songs[0] ? `${origin}/og/s/${encodeURIComponent(songs[0].slug)}.png` : undefined;
    const jsonLd = { "@context": "https://schema.org", "@type": "ProfilePage", url, mainEntity: { "@type": "MusicGroup", name: p.display_name, alternateName: `@${p.handle}`, url, ...(p.bio ? { description: p.bio } : {}),
      track: songs.slice(0, 20).map((x) => ({ "@type": "MusicRecording", name: x.title, url: `${origin}/s/${encodeURIComponent(x.slug)}` })) } };
    const body = `<h1>${htmlEsc(p.display_name)}${opts.proOf?.(p.user_id) ? ` <span class="pro">Pro</span>` : ""}</h1><p class="by">@${htmlEsc(p.handle)}${p.badge ? ` · ${htmlEsc(p.badge)}` : ""}</p>${p.bio ? `<p>${htmlEsc(p.bio)}</p>` : ""}
<h2>${n} public song${n === 1 ? "" : "s"}</h2><ul>${songs.map((x) => { const l = labelsOf(x.labels); return `<li><a href="/s/${encodeURIComponent(x.slug)}">${htmlEsc(x.title)}</a>${l.length ? ` <span>${htmlEsc(l.join(", "))}</span>` : ""}</li>`; }).join("")}</ul>`;
    return render(reply, { title: `${p.display_name} (@${p.handle}) · GBK Composer`, description: desc.slice(0, 300), url, index: true, type: "profile", image: latest, jsonLd, body,
      extraHead: `    <meta property="profile:username" content="${htmlEsc(p.handle)}" />\n` }, req);
  });
}

// Matches the social palette (light default, dark via prefers-color-scheme) so the pre-hydrate block does not flash.
const SSR_CSS = `.ssr{max-width:760px;margin:0 auto;padding:32px 20px;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#16324a;background:#fdfefe;min-height:100vh}
.ssr h1{margin:0 0 4px;font-size:32px;line-height:1.2}.ssr h2{font-size:18px;margin:24px 0 8px}.ssr a{color:#2d6a93}.ssr .by{margin:0 0 16px;color:#5f7a90}
.ssr .pro{display:inline-block;vertical-align:middle;padding:2px 9px;border-radius:999px;background:#f7b500;color:#241a00;font-size:13px;font-weight:700;letter-spacing:.02em}
.ssr dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0}.ssr dt{color:#5f7a90}.ssr dd{margin:0}
.ssr blockquote{margin:0;padding:10px 14px;border-left:4px solid #61a6d1;background:#eef3f7;border-radius:6px;white-space:pre-wrap}
@media (prefers-color-scheme: dark){body{background:#0b1620}.ssr{color:#e6f0f8;background:#0b1620}.ssr a{color:#61a6d1}.ssr .by,.ssr dt{color:#93acc0}.ssr blockquote{background:#1c3247}}`;

export function isoDuration(secs: number): string {
  const t = Math.max(1, Math.round(secs)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}${s || (!h && !m) ? `${s}S` : ""}`;
}
const clock = (secs: number) => { const t = Math.round(secs); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
/** Rendered audio length when known, else the note span under the first tempo. */
export function durationSeconds(wavMeta: string | null, projectJson: string): number | null {
  try { const w = wavMeta ? JSON.parse(wavMeta) : null; if (w && Number(w.durationSeconds) > 0) return Number(w.durationSeconds); } catch { /* fall through */ }
  try {
    const p = JSON.parse(projectJson) as { ppq?: number; tempos?: { microPerQuarter: number }[]; notes?: { tick: number; duration: number }[]; endTick?: number };
    let end = Number(p.endTick) || 0; for (const n of p.notes ?? []) end = Math.max(end, n.tick + n.duration);
    const ppq = Number(p.ppq) || 480, mpq = Number(p.tempos?.[0]?.microPerQuarter) || 500_000;
    const s = (end / ppq) * (mpq / 1e6); return s > 0 ? s : null;
  } catch { return null; }
}
