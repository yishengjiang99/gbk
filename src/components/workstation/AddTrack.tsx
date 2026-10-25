// "+ Track": the human way to start a project from scratch (guests and signed-in users alike). Creates a track
// with a GM program from the loaded SoundFont (default 0 = Acoustic Grand Piano) and selects it, so a click in
// the piano roll adds notes to it right away. Goes through userEdit, so a read-only share shows the Fork hint.
import { useEffect, useState } from "react";
import { workstation } from "./useWorkstation.ts";
import { newId } from "../../workstation/model.ts";
import { reportError } from "../../telemetry/error-reporter.ts";

/** Until the SoundFont is parsed, offer the default only (its name is the GM standard name). */
const FALLBACK = [{ program: 0, name: "Acoustic Grand Piano" }];

function gmPrograms(): { program: number; name: string }[] {
  const all = workstation.host.listPresets?.() ?? [];
  const byProg = new Map<number, string>();
  for (const p of all) if (p.bank === 0 && p.program >= 0 && p.program < 128 && !byProg.has(p.program)) byProg.set(p.program, p.name.trim() || `Program ${p.program}`);
  return byProg.size ? [...byProg.entries()].sort((a, b) => a[0] - b[0]).map(([program, name]) => ({ program, name })) : FALLBACK;
}

/** Next free melodic channel (skips 9 = GM drums). */
function nextChannel(): number {
  const used = new Set(workstation.project.tracks.map((t) => t.channel));
  for (let c = 0; c < 16; c++) if (c !== 9 && !used.has(c)) return c;
  return 0;
}

export function addTrack(program = 0, name?: string): string | null {
  const id = newId("trk"); const channel = nextChannel();
  const label = (name ?? gmPrograms().find((p) => p.program === program)?.name ?? "Piano").slice(0, 64);
  const r = workstation.userEdit([{ op: "addTrack", id, name: label, channel, program, bankMsb: 0, bankLsb: 0 }], { label: `add track "${label}"` });
  if (!r) return null;
  workstation.setSelection({ trackIds: [id], noteIds: [] });
  return id;
}

/** Button + inline instrument picker. `cta` renders the bigger empty-state variant. */
export function AddTrackButton({ cta = false, testId = "add-track" }: { cta?: boolean; testId?: string }) {
  const [open, setOpen] = useState(false);
  const [program, setProgram] = useState(0);
  const [progs, setProgs] = useState(gmPrograms);
  useEffect(() => {
    if (!open) return; let live = true;
    setProgs(gmPrograms());
    void workstation.host.ensureSoundFont?.().then(() => { if (live) setProgs(gmPrograms()); }).catch((e) => reportError(e, { where: "addTrack.ensureSoundFont" }));
    return () => { live = false; };
  }, [open]);
  const start = () => { if (workstation.readOnlyReason) { addTrack(); return; } setOpen(true); };
  if (!open) return <button type="button" className={cta ? "ws-new ws-addtrack-cta" : "ws-new ws-addtrack"} data-testid={testId} onClick={start} title="Add an instrument track">＋ Track</button>;
  return (
    <div className="ws-addtrack-form ws-row" data-testid={`${testId}-form`}>
      <select aria-label="Instrument" data-testid="add-track-instrument" value={program} onChange={(e) => setProgram(+e.target.value)}>
        {progs.map((p) => <option key={p.program} value={p.program}>{p.program + 1}. {p.name}</option>)}
      </select>
      <button type="button" className="ws-new" data-testid="add-track-confirm" onClick={() => { const name = progs.find((p) => p.program === program)?.name; addTrack(program, name); setOpen(false); setProgram(0); }}>Add</button>
      <button type="button" onClick={() => setOpen(false)} aria-label="Cancel add track">✕</button>
    </div>
  );
}
