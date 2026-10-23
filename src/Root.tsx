import { useCallback, useEffect, useState } from "react";
import App from "./App";
import { WorkstationView } from "./components/workstation/WorkstationView.tsx";
import { ExplorePage } from "./components/explore/ExplorePage.tsx";
import { parseRoute, navigate, appUrl, type Route } from "./agent/routes.ts";
import { apiBase } from "./agent/bridge-client.ts";
import { openShared } from "./agent/share-client.ts";

/** Is the Composer server (same-origin /api) present? Not on the GitHub Pages build: then GBK behaves as before. */
function useComposerAvailable(): boolean | null {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => { let live = true; fetch(`${apiBase()}/config`, { credentials: "same-origin" }).then((r) => r.ok && (r.headers.get("content-type") ?? "").includes("json")).catch(() => false).then((v) => { if (live) setOk(v); }); return () => { live = false; }; }, []);
  return ok;
}

/** Workstation is the main view; the original player/playlist app lives in an always-mounted modal (audio engine stays alive). */
export default function Root() {
  const [playerOpen, setPlayerOpen] = useState(() => typeof location !== "undefined" && new URLSearchParams(location.search).get("player") === "1");
  const [route, setRoute] = useState<Route>(() => parseRoute());
  const [shareErr, setShareErr] = useState("");
  const composer = useComposerAvailable();
  useEffect(() => { const f = () => setRoute(parseRoute()); window.addEventListener("popstate", f); return () => window.removeEventListener("popstate", f); }, []);
  useEffect(() => {
    if (route.view !== "share") return;
    setShareErr("");
    void openShared(route.slug, route.fork).then((sh) => { if (sh.slug && sh.slug !== route.slug) history.replaceState(null, "", appUrl(`s/${sh.slug}`) + location.search); }).catch((e) => setShareErr(`Could not open shared song: ${(e as Error).message}`));
  }, [route]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && playerOpen) setPlayerOpen(false); };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [playerOpen]);
  const compose = useCallback((prompt?: string) => {
    sessionStorage.setItem("gbk.focusComposer", "1"); if (prompt) sessionStorage.setItem("gbk.composerDraft", prompt);
    navigate("studio"); setTimeout(() => window.dispatchEvent(new Event("gbk:focus-composer")), 50);
  }, []);
  const explore = composer === true && route.view === "explore";
  useEffect(() => { document.documentElement.classList.toggle("studio-fit", !explore); return () => document.documentElement.classList.remove("studio-fit"); }, [explore]);
  return (
    <>
      {explore && <ExplorePage onCompose={compose} onOpen={(slug, fork) => navigate(`s/${slug}${fork ? "?fork=1" : ""}`)} />}
      {/* While the player modal is open the workstation is inert + hidden from the a11y tree (proper modal semantics). */}
      <div hidden={explore || undefined} aria-hidden={playerOpen || undefined} ref={(el) => { if (el) { if (playerOpen) el.setAttribute("inert", ""); else el.removeAttribute("inert"); } }}>
        {shareErr && <div className="cmp-error" role="alert">{shareErr}</div>}
        <WorkstationView onOpenPlayer={() => setPlayerOpen(true)} composer={composer === true} onExplore={() => navigate("")} />
      </div>
      <div className={`ws-player-modal ${playerOpen ? "open" : ""}`} role="dialog" aria-modal={playerOpen} aria-hidden={!playerOpen} aria-label="Player and library" data-testid="player-modal">
        <div className="ws-player-frame">
          <button className="ws-player-close" data-testid="close-player" onClick={() => setPlayerOpen(false)} aria-label="Close player">✕ Close player</button>
          <App />
        </div>
      </div>
    </>
  );
}
