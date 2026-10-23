import type { WorkstationController } from "../workstation/controller.ts";
import { buildCoreTools, type ToolDef } from "./tools.ts";
export function buildAllTools(c: WorkstationController): ToolDef[] { return [...buildCoreTools(c)]; }
