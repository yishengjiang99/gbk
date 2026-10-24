// Browser error reporting: captures window "error", "unhandledrejection", console.error and explicit
// reportError(err, context) calls, then batches, dedupes and rate-limits them before POSTing to
// /api/client-errors (navigator.sendBeacon on page hide, fetch keepalive otherwise). The server attaches the
// signed-in user id from the session cookie; the client never sends tokens, cookies or query strings.
declare const __GBK_RELEASE__: string | undefined;

export type ErrorKind = "error" | "unhandledrejection" | "console" | "report";
export interface ClientErrorReport {
  kind: ErrorKind; message: string; stack: string; url: string; userAgent: string; release: string; ts: number;
  count: number; context: Record<string, unknown>; breadcrumbs: string[];
}
export interface ReporterOptions {
  endpoint?: string; flushMs?: number; maxPerMinute?: number; maxPerPage?: number; maxBatch?: number;
  now?: () => number; send?: (url: string, body: string, unloading: boolean) => void;
}

const LIMITS = { message: 1000, stack: 6000, url: 500, ua: 300, crumb: 160, crumbs: 20, contextJson: 2000 };
const SECRET_RES: [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\b(access_token|refresh_token|id_token|token|code|state|password|secret|api[_-]?key|csrf|session)=([^&\s"']+)/gi, "$1=[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[jwt]"],
  [/\b(sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}/g, "[key]"],
];
/** Strip anything that looks like a credential. Shared with the server (it re-applies this on ingest). */
export function scrub(s: string): string { let out = String(s ?? ""); for (const [re, to] of SECRET_RES) out = out.replace(re, to); return out; }
/** Origin + path only: query strings and hashes can carry OAuth codes or share tokens. */
export function cleanUrl(u: string): string { try { const x = new URL(u); return `${x.origin}${x.pathname}`.slice(0, LIMITS.url); } catch { return scrub(String(u ?? "").split(/[?#]/)[0]).slice(0, LIMITS.url); } }
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

function describe(err: unknown): { message: string; stack: string } {
  if (err instanceof Error) return { message: `${err.name && err.name !== "Error" ? err.name + ": " : ""}${err.message}`, stack: err.stack ?? "" };
  if (err && typeof err === "object") {
    const o = err as { message?: unknown; stack?: unknown };
    if (typeof o.message === "string") return { message: o.message, stack: typeof o.stack === "string" ? o.stack : "" };
    try { return { message: JSON.stringify(err), stack: "" }; } catch { return { message: String(err), stack: "" }; }
  }
  return { message: String(err), stack: "" };
}
function safeContext(ctx: unknown): Record<string, unknown> {
  if (!ctx) return {};
  const c = typeof ctx === "string" ? { where: ctx } : (ctx as Record<string, unknown>);
  try { const j = scrub(JSON.stringify(c)); return j.length > LIMITS.contextJson ? { truncated: j.slice(0, LIMITS.contextJson) } : JSON.parse(j); } catch { return { where: String(ctx) }; }
}
const release = () => { try { return typeof __GBK_RELEASE__ === "string" ? __GBK_RELEASE__ : "dev"; } catch { return "dev"; } };

export class ErrorReporter {
  private queue = new Map<string, ClientErrorReport>();
  private crumbs: string[] = [];
  private window: { start: number; n: number } = { start: 0, n: 0 };
  private sentTotal = 0; private timer: ReturnType<typeof setTimeout> | undefined; private inReport = false;
  readonly opts: Required<Omit<ReporterOptions, "send">> & { send: NonNullable<ReporterOptions["send"]> };
  constructor(o: ReporterOptions = {}) {
    this.opts = { endpoint: o.endpoint ?? "/api/client-errors", flushMs: o.flushMs ?? 2000, maxPerMinute: o.maxPerMinute ?? 20, maxPerPage: o.maxPerPage ?? 100, maxBatch: o.maxBatch ?? 10, now: o.now ?? Date.now, send: o.send ?? defaultSend };
  }
  breadcrumb(msg: string) { this.crumbs.push(cut(scrub(String(msg)), LIMITS.crumb)); if (this.crumbs.length > LIMITS.crumbs) this.crumbs.shift(); }
  /** Queue one error. Duplicates (same kind + message + top stack frame) within a batch only bump `count`. */
  capture(kind: ErrorKind, err: unknown, context?: unknown) {
    if (this.inReport) return; this.inReport = true;
    try {
      const d = describe(err); const message = cut(scrub(d.message || "(no message)"), LIMITS.message);
      const stack = cut(scrub(d.stack), LIMITS.stack);
      const key = `${kind}|${message}|${stack.split("\n").slice(0, 2).join("|")}`;
      const dup = this.queue.get(key); if (dup) { dup.count++; return; }
      const t = this.opts.now();
      if (t - this.window.start >= 60_000) this.window = { start: t, n: 0 };
      if (this.window.n >= this.opts.maxPerMinute || this.sentTotal >= this.opts.maxPerPage) return;
      this.window.n++; this.sentTotal++;
      const loc = typeof location !== "undefined" ? location.href : "";
      const ua = typeof navigator !== "undefined" ? navigator.userAgent ?? "" : "";
      this.queue.set(key, { kind, message, stack, url: cleanUrl(loc), userAgent: cut(ua, LIMITS.ua), release: release(), ts: t, count: 1, context: safeContext(context), breadcrumbs: [...this.crumbs] });
      if (this.queue.size >= this.opts.maxBatch) this.flush(false);
      else if (!this.timer) { this.timer = setTimeout(() => this.flush(false), this.opts.flushMs); (this.timer as { unref?: () => void }).unref?.(); }
    } catch { /* never throw from the reporter */ } finally { this.inReport = false; }
  }
  flush(unloading: boolean) {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.queue.size) return;
    const errors = [...this.queue.values()].slice(0, this.opts.maxBatch); this.queue.clear();
    try { this.opts.send(this.opts.endpoint, JSON.stringify({ errors }), unloading); } catch { /* best effort */ }
  }
  pending() { return [...this.queue.values()]; }
}

function defaultSend(url: string, body: string, unloading: boolean) {
  if (unloading && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    try { if (navigator.sendBeacon(url, new Blob([body], { type: "application/json" }))) return; } catch { /* fall through */ }
  }
  if (typeof fetch === "function") void fetch(url, { method: "POST", body, keepalive: true, credentials: "same-origin", headers: { "content-type": "application/json" } }).catch(() => undefined);
}

let active: ErrorReporter | null = null;
/** Report a caught error with a short context ("render-job", {where, ...}). Safe to call anywhere, including Node tests. */
export function reportError(err: unknown, context?: string | Record<string, unknown>) { active?.capture("report", err, context); }
export function addBreadcrumb(msg: string) { active?.breadcrumb(msg); }

/** Install once per page (every HTML entry calls this first). Returns the reporter; idempotent. */
export function installErrorReporter(o: ReporterOptions = {}): ErrorReporter | null {
  if (active) return active;
  if (typeof window === "undefined") return null;
  // The GitHub Pages build has no Composer server to receive reports.
  if (!o.endpoint && /\.github\.io$/.test(location.hostname)) return null;
  let base = "/"; try { base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/"; } catch { /* non-Vite */ }
  const r = new ErrorReporter({ endpoint: `${base.replace(/\/$/, "")}/api/client-errors`, ...o });
  active = r;
  window.addEventListener("error", (e) => r.capture("error", e.error ?? { message: e.message, stack: e.filename ? `at ${e.filename}:${e.lineno}:${e.colno}` : "" }));
  window.addEventListener("unhandledrejection", (e) => r.capture("unhandledrejection", e.reason));
  const orig = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    orig(...args);
    const err = args.find((a) => a instanceof Error);
    const text = args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(" ");
    r.capture("console", err ? { message: text, stack: (err as Error).stack } : text);
  };
  r.breadcrumb(`load ${location.pathname}`);
  window.addEventListener("popstate", () => r.breadcrumb(`nav ${location.pathname}`));
  addEventListener("pagehide", () => r.flush(true));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") r.flush(true); });
  return r;
}
/** Test hook. */
export function _resetReporter() { active = null; }
