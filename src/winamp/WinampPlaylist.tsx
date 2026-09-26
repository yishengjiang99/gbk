import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// WinampPlaylist — the classic Winamp playlist window chrome, filled with OUR
// playlist rows (bundled manifest + scanned entries). Presentation borrows
// webamp's skin CSS (MIT, see NOTICE.md); no webamp logic is used.
// ---------------------------------------------------------------------------

export interface WinampPlaylistTrack {
  id: string;
  /** Full accessible name (e.g. "Dr Dre - Still Dre.mid"). */
  name: string;
  selected: boolean;
}

/** Winamp-style display title: strip the .mid extension, tidy separators. */
export function winampTrackTitle(name: string): string {
  return name.replace(/\.midi?$/i, "").replace(/_/g, " ");
}

export interface WinampPlaylistProps {
  tracks: WinampPlaylistTrack[];
  search: string;
  onSearchChange: (v: string) => void;
  onSelectTrack: (id: string) => void;
  headerExtra?: ReactNode;
}

export default function WinampPlaylist({
  tracks,
  search,
  onSearchChange,
  onSelectTrack,
  headerExtra,
}: WinampPlaylistProps) {
  return (
    <div id="playlist-window" className="window selected" role="region" aria-label="MIDI playlist">
      <div className="playlist-top">
        <div className="playlist-top-left" />
        <div className="playlist-top-left-fill" />
        <div className="playlist-top-title" />
        <div className="playlist-top-right-fill" />
        <div className="playlist-top-right" />
      </div>
      <div className="playlist-middle">
        <div className="playlist-middle-left" />
        <div className="playlist-middle-center">
          <div className="playlist-tracks">
            <div className="playlist-track-titles">
              {tracks.map((track, i) => (
                <div
                  key={track.id}
                  role="button"
                  tabIndex={0}
                  aria-label={track.name}
                  aria-pressed={track.selected}
                  title={track.name}
                  className={`track-cell midiPlaylistTrack${track.selected ? " selected active" : ""}`}
                  onClick={() => onSelectTrack(track.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectTrack(track.id);
                    }
                  }}
                >
                  <span className="winamp-track-index">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="winamp-track-title">{winampTrackTitle(track.name)}</span>
                </div>
              ))}
              {tracks.length === 0 && (
                <div className="track-cell winamp-track-empty">No matching MIDI files.</div>
              )}
            </div>
          </div>
        </div>
        <div className="playlist-middle-right" />
      </div>
      <div className="playlist-bottom">
        <div className="winamp-playlist-controls">
          <input
            type="search"
            className="winamp-playlist-search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search…"
            aria-label="Search playlist"
          />
          {headerExtra}
        </div>
      </div>
    </div>
  );
}
