// Server-rendered, crawlable static pages: /chatgpt (plugin landing), /privacy, /terms, /support,
// plus /robots.txt and /sitemap.xml. Bright theme, normal document scrolling (only /studio is no-scroll).
// Content is static text describing what the app actually does; no user data, no secrets.
import type { FastifyInstance } from "fastify";
import type { FunnelStore } from "../persistence/funnel.ts";
import type { Config } from "../config.ts";
import { loadGallery } from "../gallery.ts";

export const STARTER_PROMPTS = [
  "Compose a 16-bar Baroque fugue in D minor for organ, then show me the piano roll.",
  "Write a 24-bar jazz piece in F major at 140 BPM, add a walking bass, then let me render and play it in the chat.",
  "Compose a 16-bar ambient piano piece, then add a CC11 crescendo in bars 9–16 and show me the piano roll.",
];
export const SUPPORT_URL = "https://github.com/yishengjiang99/gbk/issues";
export const SUPPORT_EMAIL = "yisheng.jiang@gmail.com";
export const PAGE_PATHS = ["/chatgpt", "/privacy", "/terms", "/support"] as const;
const UPDATED = "October 24, 2026";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const PAGE_CSS = `*{box-sizing:border-box}html,body{margin:0;height:auto;overflow-y:auto}
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
pre{background:#fff;border:1px solid #ece3cf;border-radius:10px;padding:10px 14px;overflow-x:auto;font-size:13px;line-height:1.5}
.mcpurl{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.mcpurl code{padding:8px 12px;background:#fff;border:1px solid #ece3cf;border-radius:10px;font-size:15px}
.copy{padding:8px 14px;border-radius:10px;border:2px solid #3a2e9e;background:#fff;color:#3a2e9e;font-weight:600;cursor:pointer}h3{margin:20px 0 6px;font-size:17px}
footer{margin-top:48px;padding:24px 20px 40px;border-top:1px solid #ece3cf;color:#5b6070;font-size:14px}footer a{margin-right:16px}`;

export function footerLinks(): string {
  return `<a href="/">Home</a><a href="/explore">Explore</a><a href="/studio">Studio</a><a href="/chatgpt">ChatGPT plugin</a><a href="/chatgpt/gallery">Demo gallery</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/support">Support</a>`;
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
<script src="/attribution.js"></script>
<style>${PAGE_CSS}</style></head><body><header><a href="/"><img src="/icon.png" alt="" width="40" height="40">GBK Composer</a></header>
<main>${body}</main><footer><nav>${footerLinks()}</nav><p>GBK Composer by Yisheng Jiang · <a href="https://github.com/yishengjiang99/gbk">Source on GitHub</a></p></footer></body></html>`;
}

function otherAiApps(cfg: Config): string {
  const url = `${cfg.publicOrigin}/mcp`; const sr = cfg.serverRender;
  const pre = (t: string) => `<pre><code>${esc(t)}</code></pre>`;
  return `<h2 id="other-ai-apps">Use with other AI apps</h2>
<p>GBK Composer is a remote MCP server (Streamable HTTP). Add it to any MCP-capable client:</p>
<div class="mcpurl"><code id="mcp-url">${esc(url)}</code><button class="copy" type="button" data-copy="${esc(url)}">Copy</button></div>
<p>No authentication is required: compositions made without an account get private access keys. Optional OAuth sign-in (Google or GitHub) links your GBK account.</p>
<h3>Grok Bot</h3><p>Add a custom connector and paste the URL above.</p>
<h3>OpenAI Codex</h3>${pre(`codex mcp add gbk --url ${url}`)}<p>or in <code>~/.codex/config.toml</code>:</p>${pre(`[mcp_servers.gbk]\nurl = "${url}"`)}
<h3>Claude</h3><p>Settings → Connectors → Add custom connector, and enter the URL above as the remote MCP server URL.</p>
<h3>Cursor and VS Code</h3><p>Cursor <code>.cursor/mcp.json</code>:</p>${pre(`{\n  "mcpServers": {\n    "gbk": { "url": "${url}" }\n  }\n}`)}<p>VS Code <code>.vscode/mcp.json</code>:</p>${pre(`{\n  "servers": {\n    "gbk": { "type": "http", "url": "${url}" }\n  }\n}`)}
<h3>xAI API</h3><p>Remote MCP tool in the Responses API (<code>POST https://api.x.ai/v1/responses</code>):</p>${pre(`"tools": [{\n  "type": "mcp",\n  "server_url": "${url}",\n  "server_label": "gbk"\n}]`)}<p>With the xAI Python SDK: <code>mcp(server_url="${esc(url)}", server_label="gbk")</code>.</p>
<h3>WebMCP</h3><p><a href="/studio">GBK Studio</a> exposes its tools to in-page agents through WebMCP (<code>navigator.modelContext</code>).</p>
<h3>What differs from ChatGPT</h3><p>Only ChatGPT shows the in-chat player. Other clients get the WAV and MIDI rendered on GBK's server as signed download links, plus a link to open the piece in GBK Studio.</p>
<h3>Limits</h3><ul><li>Without an account: ${sr.guestPerHour} server renders per hour, up to ${sr.guestMaxSeconds} s each.</li><li>Signed in: ${sr.accountPerHour} server renders per hour, up to ${sr.accountMaxSeconds} s each.</li></ul>
<script>document.querySelectorAll("button.copy").forEach(function(b){b.addEventListener("click",function(){navigator.clipboard.writeText(b.dataset.copy).then(function(){b.textContent="Copied";setTimeout(function(){b.textContent="Copy"},1500)})})})</script>`;
}

function featured(cfg: Config): string {
  const demos = (loadGallery(cfg.dataDir)?.demos ?? []).filter((d) => d.featured);
  if (!demos.length) return "";
  return `<h2 id="listen">Listen: pieces made with GBK</h2><p>Composed by GBK's engine through the same tools ChatGPT uses, then rendered on our server.</p>
${demos.map((d) => `<h3>${esc(d.title)}</h3><audio controls preload="none" src="/chatgpt/gallery/${esc(d.slug)}/song.wav" aria-label="Play ${esc(d.title)}" style="width:100%"></audio><p>${esc(d.explanation[0] ?? "")} <a href="/chatgpt/gallery#${esc(d.slug)}">Details, piano roll and downloads</a></p>`).join("\n")}
<p><a class="cta alt" href="/chatgpt/gallery">See all demos</a></p>`;
}

function chatgpt(cfg: Config): string {
  const install = cfg.chatgptPluginUrl
    ? `<a class="cta" href="/chatgpt/install" rel="noopener">Install in ChatGPT</a>`
    : `<span class="soon">ChatGPT listing: coming soon</span>`;
  const desc = "Compose and edit structured MIDI music from ChatGPT: five styles, targeted edits, CC dynamics, a piano-roll player, and WAV/MIDI rendering.";
  const body = `<h1>GBK Composer for ChatGPT</h1>
<p class="lead">Describe a piece of music in a chat. GBK Composer writes it as real, editable MIDI, lets you revise one passage at a time, and plays and renders it to WAV and MIDI. No account needed.</p>
${install}<a class="cta alt" href="/studio">Open GBK Studio</a>
<h2>Try these prompts</h2><ol class="prompts">${STARTER_PROMPTS.map((p) => `<li>${esc(p)}</li>`).join("")}</ol>
${featured(cfg)}
<h2>What it does</h2><ul>
<li><strong>Compose</strong> in five styles: baroque (with a Bach-style fugue generator and continuo), classical, pop, jazz and ambient. Choose key, tempo, meter, length and instruments.</li>
<li><strong>Edit precisely.</strong> Add a melody, bass, walking bass, chords, arpeggio, drums or counterpoint part; transpose, invert, quantize, humanize or vary notes; double a line at the octave; shape dynamics with CC curves; change tempo, instruments or the mix. Each edit is saved as a new revision and leaves other sections untouched.</li>
<li><strong>Listen and look</strong> in an in-chat player with a piano roll, track list and dynamics lanes.</li>
<li><strong>Instruments</strong> come from the bundled GeneralUser GS SoundFont: violin, viola, cello, strings, harpsichord, piano, organ, flute, oboe, clarinet, bassoon, horn, trumpet, guitar, bass, choir, drums and more.</li></ul>
<h2>Rendering happens in your browser</h2>
<p class="note">Press <strong>Render</strong> in the in-chat player and the WAV is synthesized right there in your browser with the GBK SoundFont engine, then plays in the chat with a download (MIDI downloads straight from the chat). Clients without a browser, such as Codex, get the WAV rendered on GBK's server with the same engine and a download link, together with the MIDI file. If you sign in, a WAV can also be rendered in your open <a href="/studio">GBK Studio</a> tab.</p>
<h2>Private by default, no account needed</h2><p>From ChatGPT you can compose without signing in: each piece gets a private access key that only your chat holds. If you later sign in, you can claim a piece into your GBK account for safekeeping, or ask GBK to delete it. Either way it stays private. GBK publishes a public share page only when you explicitly ask it to. See the <a href="/privacy">privacy policy</a>.</p>
<p><a href="#other-ai-apps">Use with other AI apps</a></p>${otherAiApps(cfg)}`;
  return page(cfg, "/chatgpt", "GBK Composer for ChatGPT: compose and edit MIDI music", desc, body, {
    "@context": "https://schema.org", "@type": "SoftwareApplication", name: "GBK Composer", applicationCategory: "MultimediaApplication",
    operatingSystem: "Web", url: `${cfg.publicOrigin}/chatgpt`, image: `${cfg.publicOrigin}/icon.png`, description: desc,
    author: { "@type": "Person", name: "Yisheng Jiang" }, offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  });
}

function privacy(cfg: Config): string {
  return page(cfg, "/privacy", "Privacy policy · GBK Composer", "What GBK Composer collects, how it is used and stored, and your choices.", `<h1>Privacy policy</h1><p>Last updated ${UPDATED}.</p>
<p>This policy covers GBK Composer at ${esc(cfg.publicOrigin)}, including GBK Studio, shared song pages, and the GBK Composer plugin/MCP server used from ChatGPT and other MCP clients.</p>
<h2>Account information</h2><p>You sign in with Google or GitHub. We receive and store your provider account id, your display name (GitHub login or Google name) and, when the provider supplies a verified address, your email address. We do not receive your Google or GitHub password. A single username/password account exists only for app-store review (OpenAI's reviewers); its password is stored on our server only as a salted hash. A session cookie keeps you signed in for up to 30 days, and a CSRF cookie protects requests.</p>
<h2>Your music and conversations</h2><ul>
<li>Projects, compositions and their revision history (notes, tracks, sections, controller automation, titles), rendered WAV/MIDI files, and your conversations with the in-app composer agent are stored on our server in SQLite databases and files, linked to your account.</li>
<li>Songs are <strong>private by default</strong>. A song becomes public only when you publish or share it; a published song's page, title, owner name and audio can then be viewed by anyone with the link and may appear on the Explore page.</li></ul>
<h2>Using the plugin without an account</h2><p>The GBK Composer plugin works without signing in. When you create a composition this way, we store the composition, its revision history and its MIDI files on our server with no account and no name attached, and return a private access key (plus a separate read-only key) to the calling app, such as ChatGPT. We do not keep a copy of the key in a form that lets us give it back. Anyone holding the key can open the composition, so keep it private. If the key is lost, the composition cannot be recovered. While you still have the key you can sign in and claim the composition into your GBK account, which then becomes the way to recover it. Private Studio links contain only the read-only key, inside the part of the link after #, which browsers do not send to servers. Guest compositions are subject to size, rate and daily limits.</p>
<h2>AI processing</h2><p>The in-app composer agent sends your chat messages and the relevant project context to xAI's API to generate responses. The API key is held only on our server and is never sent to your browser. When you use GBK Composer from ChatGPT, your prompts are handled by ChatGPT under OpenAI's terms; our server receives only the tool calls ChatGPT makes (for example, create or edit a composition).</p>
<h2>Audio rendering</h2><p>Audio is synthesized either in your browser (GBK Studio, or the player shown inside ChatGPT) or, when the app you use has no browser (for example Codex), on our server. Server rendering uses only GBK's own SoundFont engine on our machine: your composition is not sent to any other service, and no third-party audio or AI provider is involved. The resulting WAV and MIDI files are stored with your composition (or account-free project) so you can download them through private, expiring links, and are deleted with it or after the artifact retention period. MIDI files are created on our server from the stored notes.</p>
<h2>Usage statistics</h2><p>To see whether the plugin works for people, our server counts a few steps per day as plain totals: page views of this site (including the demo gallery), clicks on the install button, plugin connections, first successful tool calls per connection, compositions created, edits, render requests, renders finished in the browser or on our server, failed renders, MIDI/WAV downloads, claims, publishes and deletions, split only by guest or signed-in and by player, Studio or server. These counters contain no IP address, account id, cookie, prompt, composition content or access key, and cannot be linked to you. No third-party analytics run on this site.</p>
<h2>Listening activity and your feed</h2><p>When you browse the Explore feed (web or iOS app), the app records what you listened to: which song, how long it played, whether it finished or was skipped, how fast you scrolled past it, and actions such as rating, liking, commenting, following, sharing or tapping an artist's profile. These events are linked to your account, or to a random per-device id if you are signed out. Their only use is to personalize your For you feed and to measure feed quality in aggregate. We do not sell them or share them with advertisers. Listening events are kept for at most 60 days, and they are deleted along with your account.</p>
<h2>Logs and diagnostics</h2><p>Our server keeps operational logs (such as request times, paths, IP addresses for rate limiting, account ids, and tool or error codes) and usage counters for daily limits. When something breaks in your browser, the app sends an error report (error message, stack trace, page URL without its query string, browser user agent, app version, recent app actions, and your account id if you are signed in; no IP address, cookies or tokens) so we can fix bugs. Only the most recent reports are kept. We do not use third-party analytics or advertising trackers and do not sell personal data.</p>
<h2>Retention and deletion</h2><p>Account data is kept while your account is active. You can unpublish or delete content from the app; to delete your account and its data, ask through <a href="/support">support</a>. Rendered files (WAV/MIDI) are deleted automatically after 30 days. Compositions created without an account are kept until you delete them with the plugin's delete tool (it needs the private key), claim them into a GBK account, or ask us to delete them: send the composition id through <a href="/support">support</a> (never post the access key publicly); we may ask you to prove you hold the key privately. Without the key we cannot identify which compositions are yours.</p>
<h2>Changes and contact</h2><p>We will update this page when practices change. Questions: see <a href="/support">support</a>.</p>`);
}

function terms(cfg: Config): string {
  return page(cfg, "/terms", "Terms of service · GBK Composer", "The terms for using GBK Composer, GBK Studio and the GBK Composer plugin.", `<h1>Terms of service</h1><p>Last updated ${UPDATED}.</p>
<p>By using GBK Composer (the website, GBK Studio, and the GBK Composer plugin/MCP server) you agree to these terms.</p>
<h2>The service</h2><p>GBK Composer is a free, experimental music-composition tool provided as is, without warranties. Features, daily usage limits and availability may change, and the service may be paused or discontinued at any time.</p>
<h2>Your account</h2><p>You sign in with Google or GitHub and are responsible for activity under your account. Daily limits on AI usage and renders apply per account; do not try to bypass them or disrupt the service.</p><h2>Using the plugin without an account</h2><p>The plugin can create and edit compositions without an account. Each composition is controlled by a private access key returned to the calling app. You are responsible for keeping it; a lost key cannot be recovered. While you hold the key you can sign in and claim the composition into your GBK account; without the key we cannot move it to an account. Guest use has stricter limits (length, number of edits and requests, shared daily capacity) and may be paused or turned off at any time. Rendered files expire after 30 days. You can delete such a composition yourself with the plugin (the delete tool needs its private key), claim it into an account after signing in, or request deletion through support.</p>
<h2>Your content</h2><p>You keep your rights to the music you create. You grant us the limited permission needed to store, process and display it to provide the service, and, for songs you choose to publish, to show them publicly. Do not publish content you do not have the right to share or that is unlawful or abusive; we may remove such content.</p>
<h2>AI output</h2><p>Compositions are generated with algorithmic tools and an AI model. Output may be imperfect or resemble existing music; review it before relying on it.</p>
<h2>Limitation of liability</h2><p>To the extent permitted by law, we are not liable for indirect or consequential damages or for loss of data. Keep your own copies of important files.</p>
<h2>Contact</h2><p>See <a href="/support">support</a>. See also the <a href="/privacy">privacy policy</a>.</p>`);
}

function support(cfg: Config): string {
  return page(cfg, "/support", "Support · GBK Composer", "Get help with GBK Composer, report a bug, or request account deletion.", `<h1>Support</h1>
<p>GBK Composer is supported through GitHub issues.</p><p><a class="cta" href="${SUPPORT_URL}" rel="noopener">Open a GitHub issue</a></p>
<h2>Billing and Pro support (private)</h2>
<div class="note"><p>Paying customers: for billing, refunds, receipts or subscription help, email us instead of opening a public issue: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>. We aim to reply within two business days.</p>
<p>Never send card details by email. Payments are handled by Stripe and Apple, and we will never ask for your card number, security code or bank details.</p></div>
<h2>Before you file</h2><ul>
<li><strong>Render did nothing</strong>: there are two ways to render. Ask GBK to render the piece and it renders the WAV and MIDI on our server (no browser tab needed; long pieces and busy periods hit limits, and the reply says which). Or ask GBK to show the player and press Render there, which renders in your browser (the first render downloads a ~32 MB SoundFont). You can also open the private Studio link the plugin gave you and export WAV there.</li><li><strong>Lost access key (no account)</strong>: compositions created without signing in can only be opened with their key. We cannot recover a lost key.</li>
<li><strong>Daily limit reached</strong>: AI and render limits reset daily.</li>
<li>Issues are public: describe the problem and include a song or composition id if helpful, but never post passwords, tokens or other private data.</li></ul>
<h2>Deleting a composition created without an account</h2><p>Open an issue titled "Delete guest composition" with the composition id (it starts with <code>cmp_</code>). Do not post the access key; we will arrange a private way to confirm you hold it, then delete the composition, its revisions and files.</p>
<h2>Account deletion</h2><p>Open an issue titled "Delete my account" with your GBK display name (no other personal details); we will follow up to confirm ownership and delete your account and data.</p>
<p>See also the <a href="/privacy">privacy policy</a> and <a href="/terms">terms</a>.</p>`);
}

export function pageRoutes(app: FastifyInstance, cfg: Config, funnel?: FunnelStore) {
  const html = (fn: (c: Config) => string) => async (_req: unknown, reply: import("fastify").FastifyReply) =>
    (funnel?.bump(fn === chatgpt ? "page_view_chatgpt" : "page_view_legal"), fn === chatgpt && !cfg.chatgptPluginUrl && funnel?.bump("install_link_unavailable"), reply).type("text/html; charset=utf-8").header("cache-control", "public, max-age=300").send(fn(cfg));
  // Install CTA goes through here so clicks are counted (aggregate only); 404 when no listing URL is configured.
  app.get("/chatgpt/install", async (_r, reply) => {
    if (!cfg.chatgptPluginUrl) { funnel?.bump("install_link_unavailable"); return reply.code(404).type("text/plain; charset=utf-8").send("The ChatGPT listing is not available yet."); }
    funnel?.bump("install_cta_click"); return reply.code(302).header("cache-control", "no-store").redirect(cfg.chatgptPluginUrl);
  });
  app.get("/chatgpt", html(chatgpt)); app.get("/privacy", html(privacy)); app.get("/terms", html(terms)); app.get("/support", html(support));
  app.get("/robots.txt", async (_r, reply) => reply.type("text/plain; charset=utf-8").send(
    `User-agent: *\nAllow: /\nAllow: /api/shares/*/media/mp3\nDisallow: /api/\nDisallow: /oauth/\nDisallow: /mcp\nSitemap: ${cfg.publicOrigin}/sitemap.xml\n`));
}

/** OpenAI plugin domain verification: serve the exact portal token as plain text (OPENAI_APPS_CHALLENGE). 404 until set. */
export function openaiChallengeRoute(app: FastifyInstance, token: string) {
  app.get("/.well-known/openai-apps-challenge", async (_r, reply) => token ? reply.type("text/plain; charset=utf-8").header("cache-control", "no-store").send(token) : reply.code(404).send("not configured"));
}
