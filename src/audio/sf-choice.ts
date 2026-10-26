// Which SoundFont the live player (App.tsx) has loaded, and a request channel to switch it from the studio.
// App owns the download/parse (playback + renderer cache); the desktop studio's bank picker only asks.
export interface SfChoice { label: string; path: string }
let current: SfChoice | null = null;
const subs = new Set<(c: SfChoice | null) => void>();
export const sfChoice = {
  get: () => current,
  set(c: SfChoice) { current = c; for (const f of subs) f(c); },
  subscribe(f: (c: SfChoice | null) => void) { subs.add(f); return () => { subs.delete(f); }; },
  /** Ask the player to load a manifest font (path is deployment-resolved). */
  request(path: string, label: string, bytes?: number) { window.dispatchEvent(new CustomEvent("gbk:select-soundfont", { detail: { path, label, bytes } })); },
};
