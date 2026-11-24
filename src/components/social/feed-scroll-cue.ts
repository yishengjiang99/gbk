// The feed view's scroll cue: a one-time bounce plus a "Swipe up" chevron on the first card, gone for good after the
// first scroll to card 2. Constants are shared with GBK iOS; change them on both sides together.
export const FEED_CUE = {
  /** Bounce starts this long after the first song starts playing in the feed view. */
  delayMs: 2000,
  /** The feed's cards nudge up this far, showing the top of the next card. */
  distancePx: 70,
  /** Up leg: ease-out. */
  upMs: 350,
  upEasing: "cubic-bezier(0, 0, 0.58, 1)",
  /** Spring back: ease-out-back (slight overshoot). */
  backMs: 600,
  backEasing: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  label: "Swipe up",
  storageKey: "gbk_feed_scroll_cue_done",
} as const;

let memDone = false; // fallback when localStorage throws (private mode, blocked storage)
export function cueDone(): boolean {
  if (memDone) return true;
  try { return localStorage.getItem(FEED_CUE.storageKey) === "1"; } catch { return false; }
}
export function markCueDone(): void {
  memDone = true;
  try { localStorage.setItem(FEED_CUE.storageKey, "1"); } catch { /* memory only */ }
}
export const prefersReducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Bounce the feed view's cards (transform only, so scrollTop and scroll-snap are untouched). Resolves when done. */
export function bounceFeed(feed: HTMLElement): Promise<void> {
  const cards = [...feed.querySelectorAll<HTMLElement>(":scope > .so-card")].slice(0, 2);
  if (cards.length < 2) return Promise.resolve();
  const total = FEED_CUE.upMs + FEED_CUE.backMs; const split = FEED_CUE.upMs / total;
  const frames: Keyframe[] = [
    { transform: "translateY(0)", offset: 0, easing: FEED_CUE.upEasing },
    { transform: `translateY(-${FEED_CUE.distancePx}px)`, offset: split, easing: FEED_CUE.backEasing },
    { transform: "translateY(0)", offset: 1 },
  ];
  feed.dataset.cueBouncing = "1";
  const anims = cards.map((c) => c.animate(frames, { duration: total, fill: "none" }));
  return Promise.all(anims.map((a) => a.finished.catch(() => undefined))).then(() => { delete feed.dataset.cueBouncing; feed.dataset.cueBounced = "1"; });
}
