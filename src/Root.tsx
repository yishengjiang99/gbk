import { useEffect, useState } from "react";
import App from "./App";
import { WorkstationView } from "./components/workstation/WorkstationView.tsx";

/** Workstation is the main view; the original player/playlist app lives in an always-mounted modal (audio engine stays alive). */
export default function Root() {
  const [playerOpen, setPlayerOpen] = useState(() => typeof location !== "undefined" && new URLSearchParams(location.search).get("player") === "1");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && playerOpen) setPlayerOpen(false); };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [playerOpen]);
  return (
    <>
      {/* While the player modal is open the workstation is inert + hidden from the a11y tree (proper modal semantics). */}
      <div aria-hidden={playerOpen || undefined} ref={(el) => { if (el) { if (playerOpen) el.setAttribute("inert", ""); else el.removeAttribute("inert"); } }}>
        <WorkstationView onOpenPlayer={() => setPlayerOpen(true)} />
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
