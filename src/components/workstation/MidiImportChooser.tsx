// MIDI upload: one chooser for every entry point (Settings "Import…", desktop drag-and-drop onto the studio).
// Dispatch `gbk:midi-file` with { file } to open it. The user picks: new project, or add tracks to the current one.
import { useEffect, useState } from "react";
import { workstation } from "../../workstation/instance.ts";
import { importMidiFile, isMidiFile } from "../../workstation/midi-import.ts";

export const openMidiFile = (file: File) => window.dispatchEvent(new CustomEvent<{ file: File }>("gbk:midi-file", { detail: { file } }));

export function MidiImportChooser() {
  const [file, setFile] = useState<File | null>(null); const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { const f = (e: Event) => { setFile((e as CustomEvent<{ file: File }>).detail.file); setMsg(""); }; window.addEventListener("gbk:midi-file", f); return () => window.removeEventListener("gbk:midi-file", f); }, []);
  // Desktop: drop a .mid anywhere on the studio.
  useEffect(() => {
    const over = (e: DragEvent) => { if (document.documentElement.classList.contains("studio-fit") && [...(e.dataTransfer?.items ?? [])].some((i) => i.kind === "file")) e.preventDefault(); };
    const drop = (e: DragEvent) => { const f = e.dataTransfer?.files?.[0]; if (!f || !document.documentElement.classList.contains("studio-fit")) return; e.preventDefault(); if (isMidiFile(f)) openMidiFile(f); else { setFile(null); setMsg("Drop a .mid or .midi file."); } };
    window.addEventListener("dragover", over); window.addEventListener("drop", drop); return () => { window.removeEventListener("dragover", over); window.removeEventListener("drop", drop); };
  }, []);
  const go = async (mode: "new" | "merge") => { if (!file) return; setBusy(true); try { const r = await importMidiFile(file, workstation, mode); setMsg(`Imported ${r.tracks} track${r.tracks === 1 ? "" : "s"}, ${r.notes} notes.`); setFile(null); } catch (e) { setMsg((e as Error).message); setFile(null); } finally { setBusy(false); } };
  if (!file && !msg) return null;
  const hasTracks = workstation.project.tracks.length > 0 && !workstation.readOnlyReason;
  return (
    <div className="ws-midi-imp" role="dialog" aria-label="Import MIDI" data-testid="midi-import">
      {file ? <>
        <div>Import <b>{file.name}</b></div>
        <div className="ws-row">
          <button disabled={busy} data-testid="midi-import-new" onClick={() => void go("new")}>Open as new project</button>
          {hasTracks && <button disabled={busy} data-testid="midi-import-merge" onClick={() => void go("merge")}>Add to current project</button>}
          <button disabled={busy} onClick={() => setFile(null)}>Cancel</button>
        </div>
      </> : <div className="ws-row"><span data-testid="midi-import-msg" role="status">{msg}</span><button aria-label="Dismiss" onClick={() => setMsg("")}>✕</button></div>}
    </div>
  );
}
