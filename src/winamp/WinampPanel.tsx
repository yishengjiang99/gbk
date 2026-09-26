import { useState, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// WinampPanel — a generic Winamp-styled collapsible window used to rehouse the
// app's existing panels (Bach composer, track mixer/timeline, sheet tools,
// metadata) without changing their internals.
// ---------------------------------------------------------------------------

export default function WinampPanel({
  title,
  children,
  defaultOpen = true,
  ariaLabel,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="winamp-gen-window" aria-label={ariaLabel ?? title}>
      <div className="winamp-gen-titlebar">
        <button
          type="button"
          className="winamp-gen-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${title}`}
          title={open ? "Collapse" : "Expand"}
        >
          {open ? "\u2212" : "+"}
        </button>
        <span className="winamp-gen-title">{title}</span>
      </div>
      {open && <div className="winamp-gen-body">{children}</div>}
    </section>
  );
}
