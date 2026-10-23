// Voice settings, the preset list and the Sound panel resolve presets through the RENDERER's SoundFont and mapping
// (the same one gbk_render_wav uses), loading it on demand, so they can never disagree with what renders.
import type { WorkstationController } from "../workstation/controller.ts";
import { resolveTrackPreset } from "./offline-renderer.ts";
import { peekSoundFont, listPresets, loadSoundFont } from "./soundfont-loader.ts";

export function bindRendererSoundFont(c: WorkstationController) {
  c.host.trackRegions = (project, trackId) => { const sf = peekSoundFont()?.sf; return sf ? resolveTrackPreset(project, trackId, sf) : null; };
  c.host.listPresets = () => { const sf = peekSoundFont()?.sf; return sf ? listPresets(sf) : []; };
  c.host.ensureSoundFont = async () => { await loadSoundFont(); };
}
