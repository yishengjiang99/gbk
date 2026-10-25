import { useCallback, useEffect, useState } from "react";
import App from "./App";
import { WorkstationView } from "./components/workstation/WorkstationView.tsx";
import { SocialApp } from "./components/social/SocialApp.tsx";
import { SignInSheet } from "./components/auth/SignInSheet.tsx";
import { MidiImportChooser } from "./components/workstation/MidiImportChooser.tsx";
import "./components/social/social.css";
import { parseRoute, navigate, appUrl, type Route } from "./agent/routes.ts";
import { apiBase } from "./agent/bridge-client.ts";
import { openShared } from "./agent/share-client.ts";
import { reportError } from "./telemetry/error-reporter.ts";

/** Is the Composer server (same-origin /api) present? Not on the GitHub Pages build: then GBK behaves as before. */
function useComposerAvailable(): boolean | null {
  const [ok, setOk] = useState<boolean | null>(null);
  // Only a definitive answer (a response that is not our JSON, e.g. the static Pages build) means "no server".
  // A network error (reload in flight, mid-deploy) is retried instead of flipping the social routes to the studio.
  useEffect(() => { let live = true; const go = (n: number) => fetch(`${apiBase()}/config`, { credentials: "same-origin" })
    .then((r) => { if (live) setOk(r.ok && (r.headers.get("content-type") ?? "").includes("json")); })
    .catch(() => { if (!live) return; if (n < 4) setTimeout(() => go(n + 1), 400 * (n + 1)); else setOk(false); });
    void go(0); return () => { live = false; }; }, []);
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
    void openShared(route.slug, route.fork).then((sh) => { setShareTitle(sh.title); if (sh.slug && sh.slug !== route.slug) history.replaceState(null, "", appUrl(`s/${sh.slug}`) + location.search); }).catch((e) => { reportError(e, { where: "openShared", slug: route.slug }); setShareErr(`Could not open shared song: ${(e as Error).message}`); });
  }, [route]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && playerOpen) setPlayerOpen(false); };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [playerOpen]);
  const compose = useCallback((prompt?: string) => {
    sessionStorage.setItem("gbk.focusComposer", "1"); if (prompt) sessionStorage.setItem("gbk.composerDraft", prompt);
    navigate("studio"); setTimeout(() => window.dispatchEvent(new Event("gbk:focus-composer")), 50);
  }, []);
  // Social routes render the Feed from the first paint: only a confirmed "no Composer server" (static Pages build) falls back to the studio.
  const explore = composer !== false && (route.view === "feed" || route.view === "profile" || route.view === "inbox" || route.view === "admin");
  useEffect(() => { document.documentElement.classList.toggle("studio-fit", !explore); return () => document.documentElement.classList.remove("studio-fit"); }, [explore]);
  return (
    <>
      {explore && <SocialApp route={route as import("./agent/routes.ts").SocialRoute} onOpen={(slug, fork) => navigate(`s/${slug}${fork ? "?fork=1" : ""}`)} />}
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
      <SignInSheet />
      {!explore && <MidiImportChooser />}
    </>
  );
}

/** Share pages (/s/<slug>): "<song title> · GBK Composer" in the tab and og:title (SPA; nginx serves static index.html). */
export function setShareTitle(title: string) {
  const t = `${(title || "Untitled").trim()} · GBK Composer`;
  document.title = t;
  let m = document.querySelector<HTMLMetaElement>('meta[property="og:title"]');
  if (!m) { m = document.createElement("meta"); m.setAttribute("property", "og:title"); document.head.appendChild(m); }
  m.content = t;
}
