import { WorkstationController } from "./controller.ts";
import { bindController, playerBridge } from "./player-bridge.ts";
import { enableAutosave, restoreLatest } from "./persistence.ts";

// One controller per page, shared by React UI and WebMCP. Survives HMR via globalThis.
const g = globalThis as { __gbkWorkstation?: WorkstationController };
export const workstation: WorkstationController = g.__gbkWorkstation ?? (g.__gbkWorkstation = new WorkstationController());
if (!(g as { __gbkBound?: boolean }).__gbkBound) {
  (g as { __gbkBound?: boolean }).__gbkBound = true;
  bindController(workstation);
  if (typeof indexedDB !== "undefined") { enableAutosave(workstation); void restoreLatest(workstation).then((ok) => { if (ok) playerBridge.restored = true; }); }
}
