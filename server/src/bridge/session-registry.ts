// user/session -> live browser connection. One active tab per user (a newer tab replaces the older one).
import type { BrowserLink } from "../agent/runtime.ts";

export class SessionRegistry<L extends BrowserLink & { user: string; close(code: number, reason: string): void }> {
  private byUser = new Map<string, L>();
  private waiters = new Map<string, Set<(l: L) => void>>();
  attach(l: L) {
    const old = this.byUser.get(l.user);
    this.byUser.set(l.user, l);
    if (old && old !== l) old.close(4409, "replaced by a newer tab");
    for (const w of this.waiters.get(l.user) ?? []) w(l);
    this.waiters.delete(l.user);
  }
  detach(l: L) { if (this.byUser.get(l.user) === l) this.byUser.delete(l.user); }
  get(user: string) { return this.byUser.get(user) ?? null; }
  waitFor(user: string, ms: number, signal: AbortSignal): Promise<L | null> {
    return new Promise((res) => {
      const set = this.waiters.get(user) ?? new Set(); this.waiters.set(user, set);
      const done = (l: L | null) => { clearTimeout(t); set.delete(fn); res(l); };
      const fn = (l: L) => done(l);
      const t = setTimeout(() => done(null), ms);
      signal.addEventListener("abort", () => done(null), { once: true });
      set.add(fn);
    });
  }
  get size() { return this.byUser.size; }
}
