import { useEffect, useState } from "react";
import { workstation } from "./useWorkstation.ts";
import { cancelVideoExport, exportVideo, subscribeVideoExport, videoExportState } from "../../video/export-video.ts";

/** "Export video" button + live progress/cancel (shared state, so header and Files tab show the same job). */
export function VideoExportButton({ compact = false }: { compact?: boolean }) {
  const [s, setS] = useState(videoExportState);
  useEffect(() => subscribeVideoExport(setS), []);
  const start = () => { exportVideo(workstation.project, { download: (b, n) => workstation.host.download?.(b, n) }).catch((e: Error) => alert(`Video export failed: ${e.message}`)); };
  if (s.running) return (
    <span className="ws-vexport" data-testid="video-export-progress" role="status">
      <progress max={1} value={s.progress} /> {compact ? "" : `${s.stage} `}{Math.round(s.progress * 100)}%
      <button onClick={cancelVideoExport} data-testid="video-export-cancel">Cancel</button>
    </span>);
  return <button onClick={start} data-testid="export-video" title={s.error ? `Last export failed: ${s.error}` : s.stage || "Render the moving piano roll with audio to a video file"}>Export video</button>;
}
