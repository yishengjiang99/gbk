// #187: keyboard open/close must drive --vvh/--vv-top from the visual viewport, and page backgrounds must match the studio surface.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeViewportVars, installViewportSync } from "../src/viewport-sync.ts";

test("computeViewportVars prefers the visual viewport and its offsetTop", () => {
  assert.deepEqual(computeViewportVars({ height: 412.6, offsetTop: 120.2 }, 844), { vvh: "413px", vvTop: "120px" });
  assert.deepEqual(computeViewportVars(null, 844), { vvh: "844px", vvTop: "0px" });
  assert.deepEqual(computeViewportVars({ height: 0, offsetTop: 0 }, 700), { vvh: "700px", vvTop: "0px" });
  assert.equal(computeViewportVars(null, 0), null);
});

test("installViewportSync updates CSS vars on visualViewport resize/scroll and cleans up", () => {
  const props = new Map<string, string>();
  const root = { style: { getPropertyValue: (k: string) => props.get(k) ?? "", setProperty: (k: string, v: string) => void props.set(k, v) } };
  const vv = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
  const winT = new EventTarget(); let frames: FrameRequestCallback[] = [];
  const observed: unknown[] = [];
  class RO { constructor(public cb: () => void) {} observe(t: unknown) { observed.push(t); } disconnect() { observed.length = 0; } }
  const win = { innerHeight: 844, visualViewport: vv, document: { documentElement: root },
    addEventListener: winT.addEventListener.bind(winT), removeEventListener: winT.removeEventListener.bind(winT),
    requestAnimationFrame: (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; }, cancelAnimationFrame: () => { frames = []; },
    ResizeObserver: RO } as any;
  const flush = () => { const f = frames; frames = []; f.forEach((cb) => cb(0)); };
  const stop = installViewportSync(win);
  assert.equal(props.get("--vvh"), "844px"); assert.equal(observed[0], root);
  vv.height = 480; vv.offsetTop = 60; vv.dispatchEvent(new Event("resize")); flush();
  assert.equal(props.get("--vvh"), "480px"); assert.equal(props.get("--vv-top"), "60px");
  vv.height = 844; vv.offsetTop = 0; vv.dispatchEvent(new Event("scroll")); flush();
  assert.equal(props.get("--vvh"), "844px"); assert.equal(props.get("--vv-top"), "0px");
  stop(); vv.height = 300; vv.dispatchEvent(new Event("resize")); flush();
  assert.equal(props.get("--vvh"), "844px");
});

test("viewport meta resizes content with the keyboard; shells size from --vvh", () => {
  assert.match(readFileSync("index.html", "utf8"), /interactive-widget=resizes-content/);
  for (const f of ["src/components/studio/mobile-studio.css", "src/components/studio/desktop-studio.css", "src/components/workstation/workstation.css"])
    assert.match(readFileSync(f, "utf8"), /height: var\(--vvh, 100dvh\)/, f);
});

test("html/body background matches the studio surface in both schemes (dark rule wins the cascade)", () => {
  for (const [f, cls] of [["src/components/studio/mobile-studio.css", "ms"], ["src/components/studio/desktop-studio.css", "ds"]]) {
    const css = readFileSync(f, "utf8");
    const base = css.indexOf(`html:has(.${cls}), html:has(.${cls}) body { background: #ffffff`);
    const dark = css.lastIndexOf(`html:has(.${cls}), html:has(.${cls}) body { background: #0d0f14`);
    assert.ok(base >= 0 && dark > base, `${f}: dark page background must follow the bright base rule`);
  }
});
