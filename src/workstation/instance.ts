import { WorkstationController } from "./controller.ts";
import { bindController, playerBridge } from "./player-bridge.ts";
import { enableAutosave, restoreLatest } from "./persistence.ts";

// One controller per page, shared by React UI and WebMCP. Survives HMR via globalThis.
const g = globalThis as { __gbkWorkstation?: WorkstationController };
export const workstation: WorkstationController = g.__gbkWorkstation ?? (g.__gbkWorkstation = new WorkstationController());
if (!(g as { __gbkBound?: boolean }).__gbkBound) {
  (g as { __gbkBound?: boolean }).__gbkBound = true;
  bindController(workstation);
  // Opening a shared song (/s/<slug>): skip the autosave restore and the player's startup song so the share wins.
  const shareRoute = typeof location !== "undefined" && /\/s\/[A-Za-z0-9_-]+\/?$/.test(location.pathname);
  if (shareRoute) playerBridge.holdStartupLoads = true;
  if (typeof indexedDB !== "undefined" && shareRoute) enableAutosave(workstation);
  else if (typeof indexedDB !== "undefined") { enableAutosave(workstation); void restoreLatest(workstation).then((ok) => { if (ok) playerBridge.restored = true; }); }
}

// Gallery deep link: /gbk/?song=<yyyy-mm-dd-slug> loads songs/<dir>/project.json (written by `npm run song:publish`).
if (typeof location !== "undefined" && typeof fetch !== "undefined") {
  const song = new URLSearchParams(location.search).get("song");
  if (song && /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/.test(song) && !(g as { __gbkSongLoaded?: boolean }).__gbkSongLoaded) {
    (g as { __gbkSongLoaded?: boolean }).__gbkSongLoaded = true;
    const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
    // Load after the autosave restore had its chance; a player session-restore later skips agent-owned projects
    // with revision > 0 (player-bridge), so the opened song stays.
    void new Promise((r) => setTimeout(r, 400)).then(() => fetch(`${base}songs/${song}/project.json`)).then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const p = await r.json();
      if (!p || !Array.isArray(p.tracks) || !Array.isArray(p.notes) || typeof p.ppq !== "number") throw new Error("invalid project.json");
      workstation.load({ ...p, revision: Math.max(1, p.revision ?? 1), meta: { ...(p.meta ?? {}), owner: p.meta?.owner ?? "agent" } });
    }).catch((e) => console.warn("[gbk] could not open song", song, e));
  }
}
