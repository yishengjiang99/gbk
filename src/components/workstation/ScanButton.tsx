// "📷 Scan": only inside the iOS app (window.gbkNative.scan). Opens the native scanner sheet; the
// recognized parts come back through window.gbkStudio.applyNativeOps as new tracks (src/native/scan-bridge.ts).
import { useEffect } from "react";
import { workstation } from "./useWorkstation.ts";
import { installStudioBridge, nativeScanAvailable, startNativeScan } from "../../native/scan-bridge.ts";

export function ScanButton() {
  const available = typeof window !== "undefined" && nativeScanAvailable();
  useEffect(() => { if (available) installStudioBridge(workstation); }, [available]);
  if (!available) return null;
  return (
    <button type="button" data-testid="scan-btn" onClick={() => startNativeScan(workstation)}
      title="Scan printed sheet music with the camera, a photo or a PDF — it becomes new tracks">
      📷 Scan
    </button>
  );
}
