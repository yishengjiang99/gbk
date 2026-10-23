// Key names <-> pitch classes / MIDI key-signature (FF 59) values.
import { WorkstationError } from "../workstation/ops.ts";

const PC: Record<string, number> = { C: 0, "B#": 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, Fb: 4, F: 5, "E#": 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11, Cb: 11 };
const MAJOR_SF: Record<number, number> = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1 };

export interface KeyInfo { label: string; tonic: number; mode: "major" | "minor"; sf: number }

/** "C minor", "Eb major", "f# minor", "Bb" (major), "Am" -> KeyInfo. */
export function parseKey(s: string): KeyInfo {
  const m = /^\s*([A-Ga-g])\s*([#b♯♭]?)\s*(major|minor|maj|min|m)?\s*$/i.exec(s ?? "");
  if (!m) throw new WorkstationError("INVALID_ARGUMENT", `unrecognized key ${JSON.stringify(String(s).slice(0, 40))}; use e.g. "C minor" or "Eb major"`);
  const name = m[1].toUpperCase() + (m[2] === "♯" ? "#" : m[2] === "♭" ? "b" : m[2]);
  const tonic = PC[name];
  if (tonic === undefined) throw new WorkstationError("INVALID_ARGUMENT", `unknown tonic ${name}`);
  const q = (m[3] ?? "major").toLowerCase();
  const mode = q === "minor" || q === "min" || q === "m" ? "minor" : "major";
  const sf = MAJOR_SF[mode === "minor" ? (tonic + 3) % 12 : tonic];
  return { label: `${name} ${mode}`, tonic, mode, sf };
}
