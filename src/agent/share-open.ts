/** The share route's open result, keyed by slug, so the Studio remix landing can wait for the fork the
 * route is opening. Root opens it; the Studio landing may ask before the open starts or after it settled
 * (a fast 404), so a settled result is kept until a waiter takes it or the next open of that slug begins. */
type Deferred = { promise: Promise<{ title: string }>; resolve: (v: { title: string }) => void; reject: (e: unknown) => void; waited: boolean; settled: boolean };
const pending = new Map<string, Deferred>();
const make = (): Deferred => {
  let resolve!: Deferred["resolve"]; let reject!: Deferred["reject"];
  const promise = new Promise<{ title: string }>((a, b) => { resolve = a; reject = b; }); promise.catch(() => undefined);
  return { promise, resolve, reject, waited: false, settled: false };
};
const get = (slug: string): Deferred => { let d = pending.get(slug); if (!d) { d = make(); pending.set(slug, d); } return d; };
/** Root side, as the share route starts opening `slug`: drop a stale settled result from an earlier open. */
export const beginShareOpen = (slug: string): void => { if (pending.get(slug)?.settled) pending.delete(slug); };
/** Studio side: wait for the share route's open of `slug`. */
export const waitShareOpen = (slug: string): Promise<{ title: string }> => {
  const d = get(slug); d.waited = true; if (d.settled) pending.delete(slug); return d.promise;
};
/** Root side: report the open's outcome. Returns true when a remix landing owns the error UI. */
export const settleShareOpen = (slug: string, r: { ok: true; title: string } | { ok: false; error: unknown }): boolean => {
  const d = get(slug); d.settled = true;
  if (r.ok) d.resolve({ title: r.title }); else d.reject(r.error);
  if (d.waited) pending.delete(slug);
  return d.waited || sessionStorage.getItem("gbk.remixSlug") === slug;
};
