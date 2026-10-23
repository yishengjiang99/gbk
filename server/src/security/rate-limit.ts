// Fixed-window counters for per-IP, per-user and login limits (in memory; one process).
export class RateLimiter {
  private hits = new Map<string, { start: number; n: number }>();
  constructor(private perWindow: number, private windowMs = 60_000, private now: () => number = Date.now) {}
  /** true when allowed */
  take(key: string): boolean {
    const t = this.now(); const h = this.hits.get(key);
    if (!h || t - h.start >= this.windowMs) { this.hits.set(key, { start: t, n: 1 }); if (this.hits.size > 50_000) this.sweep(); return true; }
    if (h.n >= this.perWindow) return false;
    h.n++; return true;
  }
  retryAfterSec(key: string) { const h = this.hits.get(key); return h ? Math.max(1, Math.ceil((h.start + this.windowMs - this.now()) / 1000)) : 0; }
  private sweep() { const t = this.now(); for (const [k, h] of this.hits) if (t - h.start >= this.windowMs) this.hits.delete(k); }
}
