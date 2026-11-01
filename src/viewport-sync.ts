/**
 * Keyboard-safe layout height (issue #187).
 *
 * iOS Safari does not update `100vh`/`100dvh`/`innerHeight` until the on-screen keyboard
 * animation finishes, while the visual viewport moves immediately. Anything sized to the
 * layout viewport is then too tall/short for ~400 ms and the page background shows through
 * as a blank band. We mirror the visual viewport into CSS vars on <html> every frame it
 * changes:
 *   --vvh     visual viewport height in px (shells use `height: var(--vvh, 100dvh)`)
 *   --vv-top  visual viewport offsetTop in px (fixed shells translate by it to follow pans)
 * Always on; installed once from main.tsx.
 */
export type ViewportLike = { height: number; offsetTop: number } | null | undefined;

export function computeViewportVars(vv: ViewportLike, innerHeight: number | null | undefined): { vvh: string; vvTop: string } | null {
  const h = vv && vv.height > 0 ? vv.height : typeof innerHeight === "number" && innerHeight > 0 ? innerHeight : 0;
  if (!(h > 0)) return null;
  const top = vv && vv.offsetTop > 0 ? vv.offsetTop : 0;
  return { vvh: `${Math.round(h)}px`, vvTop: `${Math.round(top)}px` };
}

type Win = Pick<Window, "innerHeight" | "addEventListener" | "removeEventListener" | "requestAnimationFrame" | "cancelAnimationFrame"> & {
  visualViewport?: (EventTarget & { height: number; offsetTop: number }) | null;
  document: Document;
  ResizeObserver?: typeof ResizeObserver;
};

export function installViewportSync(win: Win = window as unknown as Win): () => void {
  const root = win.document.documentElement;
  const vv = win.visualViewport ?? null;
  let raf = 0;
  const apply = () => {
    raf = 0;
    const v = computeViewportVars(vv, win.innerHeight);
    if (!v) return;
    if (root.style.getPropertyValue("--vvh") !== v.vvh) root.style.setProperty("--vvh", v.vvh);
    if (root.style.getPropertyValue("--vv-top") !== v.vvTop) root.style.setProperty("--vv-top", v.vvTop);
  };
  const sync = () => { if (raf) win.cancelAnimationFrame(raf); raf = win.requestAnimationFrame(apply); };
  apply(); // first value synchronously so the initial paint already uses it
  vv?.addEventListener("resize", sync);
  vv?.addEventListener("scroll", sync);
  win.addEventListener("resize", sync);
  win.addEventListener("orientationchange", sync);
  const RO = win.ResizeObserver;
  const ro = RO ? new RO(sync) : null;
  ro?.observe(root);
  return () => {
    if (raf) win.cancelAnimationFrame(raf);
    vv?.removeEventListener("resize", sync);
    vv?.removeEventListener("scroll", sync);
    win.removeEventListener("resize", sync);
    win.removeEventListener("orientationchange", sync);
    ro?.disconnect();
  };
}
