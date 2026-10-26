// Sign-in gating (docs/social/feed-design.md "Sign-in only when an action needs it"). There is no standalone
// Sign in button: a gated action calls needSignIn(why, pending). The sheet signs the user in (OAuth redirect or
// in-place code/SMS login, both end in a page load) and the pending action is replayed by whoever owns it.
export type Pending =
  | { kind: "compose"; text: string }
  | { kind: "rate"; slug: string; stars: number }
  | { kind: "comment"; slug: string; text: string }
  | { kind: "report"; what: "song" | "comment" | "user"; target: string; label: string }
  | { kind: "profile" }
  | { kind: "inbox" }
  | { kind: "publish" };
const KEY = "gbk.pendingAction";
export const setPending = (p: Pending | null) => { if (p) sessionStorage.setItem(KEY, JSON.stringify({ ...p, at: Date.now() })); else sessionStorage.removeItem(KEY); };
/** Takes the pending action if it matches `kinds` (and is < 15 min old). */
export function takePending<K extends Pending["kind"]>(...kinds: K[]): Extract<Pending, { kind: K }> | null {
  try { const p = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as (Pending & { at: number }) | null;
    if (!p || !kinds.includes(p.kind as K)) return null; sessionStorage.removeItem(KEY); return Date.now() - p.at < 900_000 ? (p as unknown as Extract<Pending, { kind: K }>) : null; } catch { return null; }
}
export interface NeedSignIn { why: string; pending: Pending | null }
export const needSignIn = (why: string, pending: Pending | null = null) => { setPending(pending); window.dispatchEvent(new CustomEvent<NeedSignIn>("gbk:need-signin", { detail: { why, pending } })); };
