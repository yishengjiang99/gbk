// Server-rendered, crawlable static pages: /chatgpt (plugin landing), /privacy, /terms, /support,
// plus /robots.txt and /sitemap.xml. Bright theme, normal document scrolling (only /studio is no-scroll).
// Content is static text describing what the app actually does; no user data, no secrets.
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.ts";

export const STARTER_PROMPTS = [
  "Compose a 16-bar Baroque fugue in D minor for organ, then show me the piano roll.",
  "Write a 24-bar jazz piece in F major at 140 BPM, add a walking bass, then render WAV and MIDI.",
  "In my last piece, double the bass an octave lower in bars 9–16 and add a CC11 crescendo.",
];
export const SUPPORT_URL = "https://github.com/yishengjiang99/gbk/issues";
export const PAGE_PATHS = ["/chatgpt", "/privacy", "/terms", "/support"] as const;
const UPDATED = "October 24, 2026";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CSS = `*{box-sizing:border-box}html,body{margin:0;height:auto;overflow-y:auto}
body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1f2330;background:#fffdf7}
header,main,footer{max-width:860px;margin:0 auto;padding:0 20px}
header{display:flex;align-items:center;gap:12px;padding-top:20px}header a{color:inherit;text-decoration:none;font-weight:700;font-size:18px;display:flex;align-items:center;gap:10px}
header img{width:40px;height:40px;border-radius:10px}
h1{font-size:34px;line-height:1.2;margin:28px 0 8px;color:#3a2e9e}h2{margin-top:32px;color:#3a2e9e}
a{color:#3a2e9e}.lead{font-size:19px;color:#454a5c}
.cta{display:inline-block;margin:16px 12px 0 0;padding:10px 18px;border-radius:10px;background:#3a2e9e;color:#fff;text-decoration:none;font-weight:600}
.cta.alt{background:#fff;color:#3a2e9e;border:2px solid #3a2e9e}.soon{display:inline-block;margin-top:16px;padding:8px 14px;border-radius:10px;background:#ffefd2;color:#7a4b00;font-weight:600}
ol.prompts li{margin:8px 0;padding:10px 14px;background:#fff;border:1px solid #ece3cf;border-radius:10px;list-style-position:inside}
.note{padding:12px 16px;border-left:4px solid #2ec4b6;background:#effbf9;border-radius:6px}
footer{margin-top:48px;padding:24px 20px 40px;border-top:1px solid #ece3cf;color:#5b6070;font-size:14px}footer a{margin-right:16px}`;

export function footerLinks(): string {
  return `<a href="/">Home</a><a href="/explore">Explore</a><a href="/studio">Studio</a><a href="/chatgpt">ChatGPT plugin</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/support">Support</a>`;
}

function page(cfg: Config, path: string, title: string, description: string, body: string, jsonLd?: object): string {
  const origin = cfg.publicOrigin; const url = `${origin}${path}`; const img = `${origin}/icon.png`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(description)}"><link rel="canonical" href="${esc(url)}">
<meta name="robots" content="index,follow"><meta name="theme-color" content="#fffdf7">
<link rel="icon" type="image/png" href="/icon.png"><link rel="icon" type="image/svg+xml" href="/icon.svg"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="website"><meta property="og:site_name" content="GBK Composer"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(img)}">
<meta name="twitter:card" content="summary"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}"><meta name="twitter:image" content="${esc(img)}">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>` : ""}
<style>${CSS}</style></head><body><header><a href="/"><img src="/icon.png" alt="" width="40" height="40">GBK Composer</a></header>
<main>${body}</main><footer><nav>${footerLinks()}</nav><p>GBK Composer by Yisheng Jiang · <a href="https://github.com/yishengjiang99/gbk">Source on GitHub</a></p></footer></body></html>`;
}

function chatgpt(cfg: Config): string {
  const install = cfg.chatgptPluginUrl
    ? `<a class="cta" href="${esc(cfg.chatgptPluginUrl)}" rel="noopener">Install in ChatGPT</a>`
    : `<span class="soon">ChatGPT listing: coming soon</span>`;
  const desc = "Compose and edit structured MIDI music from ChatGPT: five styles, targeted edits, CC dynamics, a piano-roll player, and WAV/MIDI rendered in your own browser.";
  const body = `<h1>GBK Composer for ChatGPT</h1>
<p class="lead">Describe a piece of music in a chat. GBK Composer writes it as real, editable MIDI, lets you revise one passage at a time, and renders it to WAV and MIDI in your own browser.</p>
${install}<a class="cta alt" href="/studio">Open GBK Studio</a>
<h2>Try these prompts</h2><ol class="prompts">${STARTER_PROMPTS.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>
<h2>What it does</h2><ul>
<li><strong>Compose</strong> in five styles: baroque (with a Bach-style fugue generator and continuo), classical, pop, jazz and ambient. Choose key, tempo, meter, length and instruments.</li>
<li><strong>Edit precisely.</strong> Add a melody, bass, walking bass, chords, arpeggio, drums or counterpoint part; transpose, invert, quantize, humanize or vary notes; double a line at the octave; shape dynamics with CC curves; change tempo, instruments or the mix. Each edit is saved as a new revision and leaves other sections untouched.</li>
<li><strong>Listen and look</strong> in an in-chat player with a piano roll, track list and dynamics lanes.</li>
<li><strong>Instruments</strong> come from the bundled GeneralUser GS SoundFont: violin, viola, cello, strings, harpsichord, piano, organ, flute, oboe, clarinet, bassoon, horn, trumpet, guitar, bass, choir, drums and more.</li></ul>
<h2>Rendering happens in your browser</h2>
<p class="note">GBK's servers never synthesize audio. When you ask for WAV or MIDI, the render runs in your own signed-in <a href="/studio">GBK Studio</a> tab, then download links come back to the chat. If no Studio tab is open, GBK replies with a link to open one. Keep it open and ask again.</p>
<h2>Private by default</h2><p>Your compositions belong to your GBK account and stay private. GBK publishes a public share page only when you explicitly ask it to. See the <a href="/privacy">privacy policy</a>.</p>
<h2>Connect it yourself</h2><p>Developers can add the remote MCP server <code>${esc(cfg.publicOrigin)}/mcp</code> (Streamable HTTP, OAuth sign-in with Google or GitHub) to any MCP-capable client.</p>`;
  return page(cfg, "/chatgpt", "GBK Composer for ChatGPT: compose and edit MIDI music", desc, body, {
    "@context": "https://schema.org", "@type": "SoftwareApplication", name: "GBK Composer", applicationCategory: "MultimediaApplication",
    operatingSystem: "Web", url: `${cfg.publicOrigin}/chatgpt`, image: `${cfg.publicOrigin}/icon.png`, description: desc,
    author: { "@type": "Person", name: "Yisheng Jiang" }, offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  });
}

function privacy(cfg: Config): string {
  return page(cfg, "/privacy", "Privacy policy · GBK Composer", "What GBK Composer collects, how it is used and stored, and your choices.", `<h1>Privacy policy</h1><p>Last updated ${UPDATED}.</p>
<p>This policy covers GBK Composer at ${esc(cfg.publicOrigin)}, including GBK Studio, shared song pages, and the GBK Composer plugin/MCP server used from ChatGPT and other MCP clients.</p>
<h2>Account information</h2><p>You sign in with Google or GitHub. We receive and store your provider account id, your display name (GitHub login or Google name) and, when the provider supplies a verified address, your email address. We do not receive your Google or GitHub password. A session cookie keeps you signed in for up to 30 days, and a CSRF cookie protects requests.</p>
<h2>Your music and conversations</h2><ul>
<li>Projects, compositions and their revision history (notes, tracks, sections, controller automation, titles), rendered WAV/MIDI files, and your conversations with the in-app composer agent are stored on our server in SQLite databases and files, linked to your account.</li>
<li>Songs are <strong>private by default</strong>. A song becomes public only when you publish or share it; a published song's page, title, owner name and audio can then be viewed by anyone with the link and may appear on the Explore page.</li></ul>
<h2>AI processing</h2><p>The in-app composer agent sends your chat messages and the relevant project context to xAI's API to generate responses. The API key is held only on our server and is never sent to your browser. When you use GBK Composer from ChatGPT, your prompts are handled by ChatGPT under OpenAI's terms; our server receives only the tool calls ChatGPT makes (for example, create or edit a composition).</p>
<h2>Audio rendering</h2><p>Our server does not render audio. Synthesis runs in your browser (GBK Studio) and the resulting WAV/MIDI files are uploaded to your account so you can download them.</p>
<h2>Logs and diagnostics</h2><p>Our server keeps operational logs (such as request times, paths, IP addresses for rate limiting, account ids, and tool or error codes) and usage counters for daily limits. The app may also send error reports from your browser (error message, stack trace, page and browser version) so we can fix bugs. We do not use third-party analytics or advertising trackers and do not sell personal data.</p>
<h2>Retention and deletion</h2><p>Data is kept while your account is active. You can unpublish or delete content from the app; to delete your account and its data, ask through <a href="/support">support</a>.</p>
<h2>Changes and contact</h2><p>We will update this page when practices change. Questions: see <a href="/support">support</a>.</p>`);
}

function terms(cfg: Config): string {
  return page(cfg, "/terms", "Terms of service · GBK Composer", "The terms for using GBK Composer, GBK Studio and the GBK Composer plugin.", `<h1>Terms of service</h1><p>Last updated ${UPDATED}.</p>
<p>By using GBK Composer (the website, GBK Studio, and the GBK Composer plugin/MCP server) you agree to these terms.</p>
<h2>The service</h2><p>GBK Composer is a free, experimental music-composition tool provided as is, without warranties. Features, daily usage limits and availability may change, and the service may be paused or discontinued at any time.</p>
<h2>Your account</h2><p>You sign in with Google or GitHub and are responsible for activity under your account. Daily limits on AI usage and renders apply per account; do not try to bypass them or disrupt the service.</p>
<h2>Your content</h2><p>You keep your rights to the music you create. You grant us the limited permission needed to store, process and display it to provide the service, and, for songs you choose to publish, to show them publicly. Do not publish content you do not have the right to share or that is unlawful or abusive; we may remove such content.</p>
<h2>AI output</h2><p>Compositions are generated with algorithmic tools and an AI model. Output may be imperfect or resemble existing music; review it before relying on it.</p>
<h2>Limitation of liability</h2><p>To the extent permitted by law, we are not liable for indirect or consequential damages or for loss of data. Keep your own copies of important files.</p>
<h2>Contact</h2><p>See <a href="/support">support</a>. See also the <a href="/privacy">privacy policy</a>.</p>`);
}

function support(cfg: Config): string {
  return page(cfg, "/support", "Support · GBK Composer", "Get help with GBK Composer, report a bug, or request account deletion.", `<h1>Support</h1>
<p>GBK Composer is supported through GitHub issues.</p><p><a class="cta" href="${SUPPORT_URL}" rel="noopener">Open a GitHub issue</a></p>
<h2>Before you file</h2><ul>
<li><strong>Render did nothing / "open the studio to render"</strong>: rendering runs in your browser. Open <a href="/studio">GBK Studio</a>, sign in with the same account, keep the tab open, and try again.</li>
<li><strong>Daily limit reached</strong>: AI and render limits reset daily.</li>
<li>Issues are public: describe the problem and include a song or composition id if helpful, but never post passwords, tokens or other private data.</li></ul>
<h2>Account deletion</h2><p>Open an issue titled "Delete my account" with your GBK display name (no other personal details); we will follow up to confirm ownership and delete your account and data.</p>
<p>See also the <a href="/privacy">privacy policy</a> and <a href="/terms">terms</a>.</p>`);
}

export function pageRoutes(app: FastifyInstance, cfg: Config) {
  const html = (fn: (c: Config) => string) => async (_req: unknown, reply: import("fastify").FastifyReply) =>
    reply.type("text/html; charset=utf-8").header("cache-control", "public, max-age=300").send(fn(cfg));
  app.get("/chatgpt", html(chatgpt)); app.get("/privacy", html(privacy)); app.get("/terms", html(terms)); app.get("/support", html(support));
  app.get("/robots.txt", async (_r, reply) => reply.type("text/plain; charset=utf-8").send(
    `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /oauth/\nDisallow: /mcp\nSitemap: ${cfg.publicOrigin}/sitemap.xml\n`));
  app.get("/sitemap.xml", async (_r, reply) => reply.type("application/xml; charset=utf-8").send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${["/", "/explore", ...PAGE_PATHS].map((p) => `  <url><loc>${cfg.publicOrigin}${p}</loc></url>`).join("\n")}\n</urlset>\n`));
}
