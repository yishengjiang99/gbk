// A download link for a song file (WAV/MIDI) that goes through the export paywall first (paywall plan 2026-11-16:
// export is Pro only). Pro users get the file; everyone else gets the export paywall and no download.
import type { ReactNode } from "react";
import { requireExport, type ExportKind } from "../../agent/paywall.ts";

export function ExportLink({ href, filename, kind, testId, children }: { href: string; filename: string; kind: ExportKind; testId?: string; children: ReactNode }) {
  return (
    <a href={href} download={filename} data-testid={testId} onClick={(e) => {
      e.preventDefault();
      void requireExport(kind).then((ok) => {
        if (!ok) return;
        const a = document.createElement("a"); a.href = href; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
        window.dispatchEvent(new Event("gbk:exported"));
      });
    }}>{children}</a>
  );
}
