import { WorkstationController } from "./controller.ts";
import { bindController } from "./player-bridge.ts";

// One controller per page, shared by React UI and WebMCP. Survives HMR via globalThis.
const g = globalThis as { __gbkWorkstation?: WorkstationController };
export const workstation: WorkstationController = g.__gbkWorkstation ?? (g.__gbkWorkstation = new WorkstationController());
bindController(workstation);
