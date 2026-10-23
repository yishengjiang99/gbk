// Orchestra seating auto-pan shared by live playback (StereoPannerNode per track) and the offline renderer.

interface PanRule {
  test: RegExp;
  pan: number;
}

export const ORCHESTRA_PAN_RULES: PanRule[] = [
  { test: /\bviolin\s*(?:ii|2)\b/i, pan: -0.35 },
  { test: /\bviolin\b/i, pan: -0.75 },
  { test: /\bviola\b/i, pan: 0.3 },
  { test: /\bcello\b/i, pan: 0.65 },
  { test: /\b(double\s*bass|contrabass|upright\s*bass)\b/i, pan: 0.8 },
  { test: /\b(piccolo|flute)\b/i, pan: -0.15 },
  { test: /\boboe\b/i, pan: -0.05 },
  { test: /\bclarinet\b/i, pan: 0.05 },
  { test: /\bbassoon\b/i, pan: 0.15 },
  { test: /\b(french\s*horn|horn)\b/i, pan: -0.5 },
  { test: /\btrumpet\b/i, pan: 0.25 },
  { test: /\b(trombone|tuba)\b/i, pan: 0.5 },
  { test: /\btimpani\b/i, pan: -0.1 },
];

export function resolveOrchestraPan(...labels: (string | undefined)[]): number | null {
  const merged = labels
    .filter(Boolean)
    .join(" | ")
    .toLowerCase();
  if (!merged) return null;
  for (const rule of ORCHESTRA_PAN_RULES) {
    if (rule.test.test(merged)) return rule.pan;
  }
  return null;
}

/**
 * Web Audio StereoPannerNode on a stereo input (the live per-track panner), as a pure function so the offline
 * mix is sample-identical in law: pan <= 0 folds R into L, pan > 0 folds L into R (equal power), 0 = identity.
 */
export function stereoPanGains(pan: number): { ll: number; rl: number; lr: number; rr: number } {
  const p = Math.max(-1, Math.min(1, pan));
  if (p <= 0) { const x = (p + 1) * Math.PI / 2; return { ll: 1, rl: Math.cos(x), lr: 0, rr: Math.sin(x) }; }
  const x = p * Math.PI / 2; return { ll: Math.cos(x), rl: 0, lr: Math.sin(x), rr: 1 };
}
