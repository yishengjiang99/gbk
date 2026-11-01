// Server-derived playable media for shared songs (#189). A song's notes live in project_json, so the server can always
// produce a Standard MIDI File itself; publishing no longer depends on a client having rendered/uploaded an artifact.
import { serializeSmf } from "../../../src/workstation/smf.ts";
import { sanitizeSharedProject } from "../../../src/agent/share-schema.ts";

export const NO_PLAYABLE_MEDIA = { code: "NO_PLAYABLE_MEDIA", message: "This song has no notes yet, so there is nothing to play. Add some notes, then publish." } as const;

/** MIDI bytes for a stored project, or null when the project is invalid or has no notes (nothing playable). */
export function deriveMidi(projectJson: string): Uint8Array | null {
  let project;
  try { project = sanitizeSharedProject(JSON.parse(projectJson)); } catch { return null; }
  if (!project.notes.length || !project.tracks.length) return null;
  const midi = serializeSmf(project, { soundNrpn: true });
  return midi.length > 14 && String.fromCharCode(...midi.subarray(0, 4)) === "MThd" ? midi : null;
}
