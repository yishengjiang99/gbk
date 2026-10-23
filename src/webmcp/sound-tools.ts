// gbk_* sound-design tools: voice inspection, voice patches and global effects, all through proposals.
import type { WorkstationController } from "../workstation/controller.ts";
import { WorkstationError, type Op } from "../workstation/ops.ts";
import { voiceReport, humanEditToOverride, type HumanVoiceEdit } from "../workstation/sound.ts";
import { VOICE_PARAMS, EFFECTS_RANGES, EFFECTS_DEFAULTS } from "../sf2/voice-overrides.ts";
import { proposalView, type ToolDef } from "./tools.ts";

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const int = (minimum: number, maximum: number, description?: string) => ({ type: "integer", minimum, maximum, ...(description ? { description } : {}) });
const str = (description?: string) => ({ type: "string", maxLength: 200, ...(description ? { description } : {}) });
const BASE_REV = int(0, Number.MAX_SAFE_INTEGER, "Optimistic concurrency: the revision your edit is based on.");
const PARAM_DOC = VOICE_PARAMS.map((p) => `${p.name} (${p.unit})`).join(", ");

export function buildSoundTools(c: WorkstationController): ToolDef[] {
  const P = () => c.project;
  const track = (id: string) => { const t = P().tracks.find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase()); if (!t) throw new WorkstationError("INVALID_ARGUMENT", "unknown track; call gbk_list_tracks"); return t; };
  return [
    { name: "gbk_get_voice_settings", readOnly: true,
      description: "Effective SoundFont voice settings of a track's preset for a key/velocity: per zone, the generators (zone + overrides) in human units (seconds, Hz, dB, cents, %), the effective reverb/chorus send (zone gen16/15 + CC91/93 default modulators + overrides), current overrides and global effects.",
      inputSchema: obj({ trackId: str(), key: int(0, 127, "MIDI key (default 60)"), velocity: int(1, 127, "default 100") }, ["trackId"]),
      run: (a) => {
        const t = track(a.trackId as string);
        const host = c.host.trackRegions?.(P(), t.id) ?? null;
        const rep = voiceReport(P(), t.id, host, (a.key as number) ?? 60, (a.velocity as number) ?? 100, c.getState().transport.positionTick);
        return { data: rep, warnings: host ? (rep.zones.length ? [] : ["no zone of this preset covers that key/velocity"]) : ["SoundFont/track zones not available (load a SoundFont and play the project once); overrides and effects shown only"] };
      } },
    { name: "gbk_propose_voice_patch", readOnly: false,
      description: `Stage SF2 voice overrides for a track (layered on the SoundFont zones; applied at note-on, realtime ones also to sounding notes). Each edit: param, mode set (absolute, in the param unit) | add (delta; dB/cents/%/semitones params) | scale (factor for seconds/Hz params), optional keyLo/keyHi. Ranges follow SF2 2.01 8.1.3. Params: ${PARAM_DOC}. Returns a proposal: preview A/B, then commit (user approves).`,
      inputSchema: obj({
        trackId: str(),
        edits: { type: "array", maxItems: 64, items: obj({ param: { type: "string", enum: VOICE_PARAMS.map((p) => p.name) }, mode: { type: "string", enum: ["set", "add", "scale"] }, value: { type: "number" }, keyLo: int(0, 127), keyHi: int(0, 127) }, ["param", "mode", "value"]) },
        replace: { type: "boolean", description: "true: the edits become the track's whole override list (empty edits = reset to SoundFont)" },
        summary: str(), baseRevision: BASE_REV,
      }, ["trackId", "edits"]),
      run: (a) => {
        const t = track(a.trackId as string);
        const overrides = (a.edits as HumanVoiceEdit[]).map(humanEditToOverride);
        if (!overrides.length && !a.replace) throw new WorkstationError("INVALID_ARGUMENT", "edits is empty (use replace: true to reset)");
        const ops: Op[] = [{ op: "setVoicePatch", trackId: t.id, overrides, mode: a.replace ? "replace" : "merge" }];
        const pr = c.propose(ops, { baseRevision: a.baseRevision as number | undefined, source: "agent", summary: (a.summary as string) ?? `voice patch ${t.name}` });
        return { data: { ...proposalView(pr), overrides }, warnings: pr.validation.warnings };
      } },
    { name: "gbk_set_effects", readOnly: false,
      description: `Stage global reverb (Freeverb-style) / chorus (modulated delay) parameters as a proposal. Ranges: ${Object.entries(EFFECTS_RANGES).map(([k, r]) => `${k} ${r[0]}..${r[1]}`).join(", ")}; enabled=false is the off switch. Defaults ${JSON.stringify(EFFECTS_DEFAULTS)}. How much of each note reaches the effects is per voice: gbk_propose_voice_patch reverbSend/chorusSend or CC91/CC93 automation.`,
      inputSchema: obj({
        enabled: { type: "boolean" },
        ...Object.fromEntries(Object.entries(EFFECTS_RANGES).map(([k, r]) => [k, { type: "number", minimum: r[0], maximum: r[1] }])),
        summary: str(), baseRevision: BASE_REV,
      }),
      run: (a) => {
        const params = Object.fromEntries(Object.entries(a).filter(([k]) => k === "enabled" || k in EFFECTS_RANGES));
        if (!Object.keys(params).length) throw new WorkstationError("INVALID_ARGUMENT", "no effects parameter given");
        const pr = c.propose([{ op: "setEffects", params }], { baseRevision: a.baseRevision as number | undefined, source: "agent", summary: (a.summary as string) ?? "effects" });
        return { data: proposalView(pr), warnings: pr.validation.warnings };
      } },
  ];
}
