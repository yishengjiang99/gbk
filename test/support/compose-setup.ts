import "./offline-audio-context.ts"; // renders go through an OfflineAudioContext (test stand-in under Node)
import { readFileSync } from "node:fs";
import { WorkstationController } from "../../src/workstation/controller.ts";
import { parseSmf } from "../../src/workstation/smf.ts";
import { runTool, type ToolResult } from "../../src/webmcp/tools.ts";
import { buildAllTools } from "../../src/webmcp/registry.ts";
import { primeSoundFontCache, parseSoundFont } from "../../src/audio/soundfont-loader.ts";

primeSoundFontCache("/static/GeneralUser-GS.sf2", parseSoundFont(new Uint8Array(readFileSync("public/static/GeneralUser-GS.sf2"))).sf);

export function setup(initial?: Uint8Array) {
  const c = new WorkstationController(initial ? parseSmf(initial, "user song") : undefined);
  const saved: string[] = [];
  c.host.checkpoint = async (p) => { saved.push(p.id); };
  const tools = new Map(buildAllTools(c).map((t) => [t.name, t]));
  const call = async (name: string, args: unknown = {}, signal = new AbortController().signal): Promise<ToolResult & { data: any }> => {
    const t = tools.get(name); if (!t) throw new Error(`no tool ${name}`);
    return runTool(c, t, args, signal) as never;
  };
  return { c, call, saved, tools };
}

