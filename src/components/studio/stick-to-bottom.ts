// Chat auto-scroll: keep the newest message in view while the reader is "pinned" to the bottom (within PIN_PX),
// and leave them alone once they scroll up on purpose. Shared by the phone and desktop studio chats.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export const PIN_PX = 80;

/** True when the scroll position is within `threshold` px of the bottom (or there is nothing to scroll). */
export function isPinned(m: { scrollTop: number; clientHeight: number; scrollHeight: number }, threshold = PIN_PX): boolean {
  return m.scrollHeight - m.clientHeight - m.scrollTop <= threshold;
}

/** What to do when content or the viewport changes: follow the bottom when pinned, else flag new content. */
export function onGrow(pinned: boolean): "scroll" | "flag" {
  return pinned ? "scroll" : "flag";
}

export function useStickToBottom(ref: RefObject<HTMLElement | null>) {
  const pinned = useRef(true);
  const [unpinned, setUnpinned] = useState(false);
  const [hasNew, setHasNew] = useState(false);
  const toBottom = useCallback(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [ref]);
  /** Re-pin and jump to the newest message (chat open, user sent a message, "Jump to latest"). */
  const repin = useCallback(() => { pinned.current = true; setUnpinned(false); setHasNew(false); toBottom(); }, [toBottom]);
  // Re-attach whenever the scroll element changes (the chat <main> can remount); cheap identity check every render.
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => { if (ref.current !== el) setEl(ref.current); });
  useEffect(() => {
    if (!el) return;
    let raf = 0;
    const grow = (isContent: boolean) => {
      if (onGrow(pinned.current) === "scroll") { cancelAnimationFrame(raf); toBottom(); raf = requestAnimationFrame(toBottom); }
      else if (isContent) setHasNew(true);
    };
    const onScroll = () => { const p = isPinned(el); pinned.current = p; setUnpinned(!p); if (p) setHasNew(false); };
    const mo = new MutationObserver((recs) => { if (recs.some((r) => !(r.target instanceof Element && r.target.closest("[data-jump-pill]")))) grow(true); });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => grow(false)) : null;
    ro?.observe(el);
    const vv = window.visualViewport; const onVV = () => grow(false); // keyboard open/close (--vvh change)
    vv?.addEventListener("resize", onVV); window.addEventListener("resize", onVV);
    el.addEventListener("scroll", onScroll, { passive: true });
    toBottom(); // chat opens at the newest message
    return () => { cancelAnimationFrame(raf); mo.disconnect(); ro?.disconnect(); vv?.removeEventListener("resize", onVV); window.removeEventListener("resize", onVV); el.removeEventListener("scroll", onScroll); };
  }, [el, toBottom]);
  return { pinned, showJump: unpinned && hasNew, repin };
}
