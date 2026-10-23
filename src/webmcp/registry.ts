import type { WorkstationController } from "../workstation/controller.ts";
import { buildCoreTools, type ToolDef } from "./tools.ts";
import { buildMusicTools } from "./music-tools.ts";
import { buildSoundTools } from "./sound-tools.ts";
import { buildComposeTools } from "./compose-tools.ts";
import { buildArrangementTools } from "./arrangement-tools.ts";
export function buildAllTools(c: WorkstationController): ToolDef[] { return [...buildCoreTools(c), ...buildMusicTools(c), ...buildSoundTools(c), ...buildComposeTools(c), ...buildArrangementTools(c)]; }
