import { useEffect, useState } from "react";
import { openRecent, recentProjects } from "../../workstation/studio-api.ts";
import { workstation } from "../../workstation/instance.ts";

/** Locally autosaved projects, newest first. Titles render as text (React escapes them). */
export function RecentProjects({ onDone, className }: { onDone: () => void; className?: string }) {
  const [list, setList] = useState<{ id: string; title: string; savedAt: number }[] | null>(null);
  useEffect(() => { void recentProjects().then(setList).catch(() => setList([])); }, []);
  const cur = workstation.project.id;
  if (!list) return <div className={className} data-testid="recent-loading">Loading…</div>;
  if (!list.length) return <div className={className} data-testid="recent-empty">No saved projects yet.</div>;
  return <>{list.map((r) => <button key={r.id} role="menuitem" className={className} data-testid="recent-item" data-current={r.id === cur ? "1" : "0"} onClick={() => { void openRecent(r.id).then(onDone); }}>
    {r.id === cur ? "● " : ""}{r.title} <small>{new Date(r.savedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</small></button>)}</>;
}
