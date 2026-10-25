// Convert transcribed notes (seconds) into workstation ops that create the
// "Hummed melody" track and fill it, through the same op model the UI and
// the agent tools use (workstation/ops.ts). Pure: unit-tested in
// test/hum.test.ts.
import type { Op } from "../workstation/ops.ts";
import type { Project } from "../workstation/model.ts";
import { secToTick } from "../workstation/timing.ts";
import type { TimedNote } from "./transcribe-core.ts";

export const HUM_TRACK_NAME = "Hummed melody";
export const HUM_PROGRAM = 0; // GM Acoustic Grand Piano, the app's default melodic instrument

/** Next free melodic channel (skips 9 = GM drums); mirrors AddTrack.tsx. */
export function nextMelodicChannel(project: Pick<Project, "tracks">): number {
  const used = new Set(project.tracks.map((t) => t.channel));
  for (let c = 0; c < 16; c++) if (c !== 9 && !used.has(c)) return c;
  return 0;
}

/** Amplitude (0..1 mean frame activation) -> MIDI velocity 1..127. */
export function amplitudeToVelocity(amplitude: number | undefined): number {
  const a = typeof amplitude === "number" && Number.isFinite(amplitude) ? amplitude : 0.8;
  return Math.max(1, Math.min(127, Math.round(a * 127)));
}

/**
 * Build the [addTrack, addNotes] op pair for a hum take. Times map through
 * the project's tempo map (secToTick), so at the song's current tempo the
 * hummed rhythm lands on the same beats it was sung at. Returns [] when the
 * take produced no notes (caller shows the "no melody" feedback instead).
 */
export function humToOps(project: Project, notes: TimedNote[], trackId: string): Op[] {
  if (!notes.length) return [];
  const channel = nextMelodicChannel(project);
  const converted = notes
    .map((n) => {
      const tick = Math.max(0, secToTick(project, n.startSec));
      const endTick = Math.max(tick + 1, secToTick(project, n.endSec));
      return {
        trackId,
        channel,
        tick,
        duration: endTick - tick,
        pitch: Math.max(0, Math.min(127, Math.round(n.pitchMidi))),
        velocity: amplitudeToVelocity(n.amplitude),
      };
    })
    .sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
  return [
    { op: "addTrack", id: trackId, name: HUM_TRACK_NAME, channel, program: HUM_PROGRAM, bankMsb: 0, bankLsb: 0, role: "melody" },
    { op: "addNotes", notes: converted },
  ];
}
